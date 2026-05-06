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
        } catch (err) { console.error(`❌ [Grip] ${item.name} 오류: ${err.message}`); }
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
        } catch (err) { console.error(`❌ [Kakao] ${item.name} 오류: ${err.message}`); }
        await context.close();
    }

    await browser.close();

    // KST 시간 계산
    const now = new Date();
    const kstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const yyyy = kstNow.getUTCFullYear();
    const mm = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(kstNow.getUTCDate()).padStart(2, '0');
    const hh = String(kstNow.getUTCHours()).padStart(2, '0');
    const min = String(kstNow.getUTCMinutes()).padStart(2, '0');
    const ss = String(kstNow.getUTCSeconds()).padStart(2, '0');

    // 모든 행 한 번에 배치 저장 (Race Condition 방지)
    const sheet = doc.sheetsByTitle['FollowerStats'];
    const batchRows = Object.values(results).map(data => ({
        'Date': `${yyyy}${mm}${dd}`,
        'Hour': parseInt(hh),
        'Checked_at': `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`,
        'Seller_name': data.name,
        'Grip_Followers': data.gripFollowers,
        'Kakao_Followers': data.kakaoFriends
    }));

    await sheet.addRows(batchRows);
    console.log(`✅ ${batchRows.length}개 일괄 저장 완료`);
    console.log('✅ 모든 수집 완료');
})();
