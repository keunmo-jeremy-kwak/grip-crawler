const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

// 인증 정보 로드 (GitHub Secrets 또는 로컬 파일)
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
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');

        await sheet.addRow({
            'Date': `${yyyy}${mm}${dd}`,
            'Hour': now.getHours(),
            'Checked_at': now.toLocaleString('ko-KR'),
            'Seller_name': data.name,
            'Grip_Followers': data.gripFollowers,
            'Kakao_Followers': data.kakaoFriends
        });
        console.log(`✅ [${data.name}] 저장 완료 (G:${data.gripFollowers} / K:${data.kakaoFriends})`);
    } catch (err) { console.error(`❌ 저장 에러: ${err.message}`); }
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

    console.log(`⏱️ 지표 트래킹 시작: ${new Date().toLocaleString()}`);

    // --- [1단계: 그립 수집] ---
    for (const item of targetList) {
        const context = await browser.newContext();
        const page = await context.newPage();
        results[item.name] = { name: item.name, gripFollowers: 0, kakaoFriends: 0 };
        try {
            await page.goto(item.gripUrl, { waitUntil: 'domcontentloaded' });
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
        } catch (err) { console.error(`❌ [Grip] ${item.name} 오류`); }
        await context.close();
    }

    // --- [2단계: 카카오 수집] ---
    for (const item of targetList) {
        if (!item.kakaoUrl || !item.kakaoUrl.includes('kakao.com')) continue;
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            await page.goto(item.kakaoUrl, { waitUntil: 'domcontentloaded' });
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
        } catch (err) { console.error(`❌ [Kakao] ${item.name} 오류`); }
        await context.close();
    }

    await browser.close();

    // --- [3단계: 시트 저장] ---
    for (const key in results) {
        await saveCombinedStats(doc, results[key]);
    }
    console.log('✅ 모든 작업 완료');
})();