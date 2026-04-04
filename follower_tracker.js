const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

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
        
        // 1. 한국 시간(KST) 계산 로직
        const now = new Date();
        const kstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));

        // 2. 한국 시간 기준으로 항목 추출 (getUTC 사용 - 더해진 시간값을 기준으로 추출하기 위함)
        const yyyy = kstNow.getUTCFullYear();
        const mm = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(kstNow.getUTCDate()).padStart(2, '0');
        const hh = String(kstNow.getUTCHours()).padStart(2, '0');
        const min = String(kstNow.getUTCMinutes()).padStart(2, '0');
        const ss = String(kstNow.getUTCSeconds()).padStart(2, '0');

        const formattedDate = `${yyyy}${mm}${dd}`;
        const formattedCheckedAt = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;

        await sheet.addRow({
            'Date': formattedDate,           // 한국 기준 날짜 (YYYYMMDD)
            'Hour': parseInt(hh),            // 한국 기준 시간 (0~23)
            'Checked_at': formattedCheckedAt, // 한국 기준 전체 일시 (표준 포맷)
            'Seller_name': data.name,
            'Grip_Followers': data.gripFollowers,
            'Kakao_Followers': data.kakaoFriends
        });
        console.log(`✅ [${data.name}] 저장 완료 (KST: ${formattedCheckedAt})`);
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
        } catch (err) { console.error(`❌ [Grip] ${item.name} 오류`); }
        await context.close();
    }

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
        } catch (err) { console.error(`❌ [Kakao] ${item.name} 오류`); }
        await context.close();
    }

    await browser.close();

    for (const key in results) {
        await saveCombinedStats(doc, results[key]);
    }
    console.log('✅ 모든 수집 완료');
})();
