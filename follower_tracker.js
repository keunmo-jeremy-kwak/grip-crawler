const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

// 💡 한국 시간대(Asia/Seoul) 강제 설정을 위한 포맷터
const kstFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
});

const kstDateParts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit'
});

function getDoc() {
    let credentials;
    if (process.env.GOOGLE_CREDS) {
        credentials = JSON.parse(process.env.GOOGLE_CREDS);
    } else {
        credentials = require('./secret.json');
    }
    return new GoogleSpreadsheet(SPREADSHEET_ID, new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }));
}

async function saveCombinedStats(doc, data) {
    try {
        const sheet = doc.sheetsByTitle['FollowerStats'];
        
        const now = new Date();
        const parts = kstDateParts.formatToParts(now);
        const yyyy = parts.find(p => p.type === 'year').value;
        const mm = parts.find(p => p.type === 'month').value;
        const dd = parts.find(p => p.type === 'day').value;
        const hour = parts.find(p => p.type === 'hour').value;
        const checkedAt = kstFormatter.format(now); // 💡 여기서 한국 시간 문자열 생성

        await sheet.addRow({
            'Date': `${yyyy}${mm}${dd}`,
            'Hour': parseInt(hour),
            'Checked_at': checkedAt,
            'Seller_name': data.name,
            'Grip_Followers': data.gripFollowers,
            'Kakao_Followers': data.kakaoFriends
        });
        console.log(`✅ [${data.name}] 저장 완료 (KST 기준: ${hour}시)`);
    } catch (err) { 
        console.error(`❌ [${data.name}] 저장 에러: ${err.message}`); 
    }
}

(async () => {
    const doc = getDoc();
    await doc.loadInfo();
    const rows = await doc.sheetsByTitle['TargetURLs'].getRows();
    const targetList = rows.map(r => ({
        name: r.get('Name'),
        gripUrl: r.get('Url'),
        kakaoUrl: r.get('Kakao_Url')
    })).filter(i => i.gripUrl);

    const results = {};
    const browser = await chromium.launch({ headless: true });

    // 💡 로그 시작 시간도 KST 포맷터 사용
    console.log(`⏱️ 지표 트래킹 시작 (KST): ${kstFormatter.format(new Date())}`);

    console.log('\n--- [Grip 수집] ---');
    for (const item of targetList) {
        const context = await browser.newContext();
        const page = await context.newPage();
        results[item.name] = { name: item.name, gripFollowers: 0, kakaoFriends: 0 };
        try {
            await page.goto(item.gripUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForFunction(() => {
                const el = document.querySelector('.follower');
                return el && /\d/.test(el.innerText);
            }, { timeout: 5000 }).catch(() => {});
            
            const count = await page.evaluate(() => {
                const el = document.querySelector('.follower');
                return el ? parseInt(el.innerText.replace(/[^0-9]/g, '')) || 0 : 0;
            });
            results[item.name].gripFollowers = count;
            console.log(`🔍 [Grip] ${item.name}: ${count}`);
        } catch (err) { 
            console.error(`❌ [Grip] ${item.name} 오류`); 
        }
        await context.close();
    }

    console.log('\n--- [Kakao 수집] ---');
    for (const item of targetList) {
        if (!item.kakaoUrl || !item.kakaoUrl.includes('kakao.com')) continue;
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            await page.goto(item.kakaoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForFunction(() => {
                const el = document.querySelector('.txt_friends');
                return el && /\d/.test(el.innerText);
            }, { timeout: 5000 }).catch(() => {});
            
            const count = await page.evaluate(() => {
                const el = document.querySelector('.txt_friends');
                return el ? parseInt(el.innerText.replace(/[^0-9]/g, '')) || 0 : 0;
            });
            results[item.name].kakaoFriends = count;
            console.log(`🔍 [Kakao] ${item.name}: ${count}`);
        } catch (err) { 
            console.error(`❌ [Kakao] ${item.name} 오류`); 
        }
        await context.close();
    }

    await browser.close();

    console.log('\n--- [시트 기록] ---');
    for (const key in results) {
        await saveCombinedStats(doc, results[key]);
    }
    console.log(`\n✅ 모든 수집 완료 (종료 KST: ${kstFormatter.format(new Date())})`);
})();
