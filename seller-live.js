const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

// 헬퍼: 한국 시간(KST) 반환
function getKST() {
    const now = new Date();
    return new Date(now.getTime() + (9 * 60 * 60 * 1000));
}

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

function parseGripDateTime(dateStr, timeStr) {
    const kstNow = getKST();
    let targetDate = new Date(kstNow);
    if (dateStr.includes('내일')) targetDate.setUTCDate(kstNow.getUTCDate() + 1);
    else if (dateStr.includes('요일')) {
        const days = ['일','월','화','수','목','금','토'];
        const diff = (days.indexOf(dateStr.replace('요일','').trim()) - kstNow.getUTCDay() + 7) % 7 || 7;
        targetDate.setUTCDate(kstNow.getUTCDate() + diff);
    }
    const yyyy = targetDate.getUTCFullYear();
    const mm = String(targetDate.getUTCMonth()+1).padStart(2,'0');
    const dd = String(targetDate.getUTCDate()).padStart(2,'0');
    return { formattedDate: `${yyyy}${mm}${dd}`, formattedTime: timeStr.replace(/[^0-9:]/g, '') };
}

function parseStoryDate(dateStr) {
    const kstNow = getKST();
    let targetDate = new Date(kstNow);
    const value = parseInt(dateStr.replace(/[^0-9]/g, '')) || 0;
    if (dateStr.includes('시간')) targetDate.setUTCHours(kstNow.getUTCHours() - value);
    else if (dateStr.includes('일')) targetDate.setUTCDate(kstNow.getUTCDate() - value);
    else if (dateStr.includes('주')) targetDate.setUTCDate(kstNow.getUTCDate() - (value * 7));
    
    const yyyy = targetDate.getUTCFullYear();
    const mm = String(targetDate.getUTCMonth()+1).padStart(2,'0');
    const dd = String(targetDate.getUTCDate()).padStart(2,'0');
    return `${yyyy}${mm}${dd}`;
}

(async () => {
    const doc = getDoc();
    await doc.loadInfo();
    const targetRows = await doc.sheetsByTitle['TargetURLs'].getRows();
    const targetList = targetRows.map(r => ({ name: r.get('Name'), url: r.get('Url') })).filter(i => i.url);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    for (const item of targetList) {
        try {
            const kstNow = getKST();
            const timestamp = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth()+1).padStart(2,'0')}-${String(kstNow.getUTCDate()).padStart(2,'0')} ${String(kstNow.getUTCHours()).padStart(2,'0')}:${String(kstNow.getUTCMinutes()).padStart(2,'0')}:${String(kstNow.getUTCSeconds()).padStart(2,'0')}`;

            // [소식 수집]
            const storyUrl = item.url.replace('tab=live', 'tab=story');
            await page.goto(storyUrl, { waitUntil: 'networkidle' });
            const stories = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.story-item.white')).slice(0, 3).map(card => ({
                    content: card.querySelector('.story-description')?.innerText.split('\n')[0] || "",
                    rawDate: card.querySelector('.created-at')?.innerText || ""
                }));
            });

            const storySheet = doc.sheetsByTitle['StoryData'];
            for (const s of stories) {
                if (!s.content) continue;
                await storySheet.addRow({
                    'Scraped_at': timestamp,
                    'Seller_name': item.name,
                    'Content': s.content,
                    'Date': parseStoryDate(s.rawDate),
                    'Url': storyUrl
                });
            }

            // [라이브 일정 수집]
            await page.goto(item.url, { waitUntil: 'networkidle' });
            const lives = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.content-list-item')).map(el => {
                    const sched = el.querySelector('.schedule-cover');
                    if (!sched) return null;
                    return {
                        title: el.querySelector('.title')?.innerText || "",
                        date: sched.querySelector('.date')?.innerText || "",
                        time: sched.querySelector('.time')?.innerText || ""
                    };
                }).filter(r => r);
            });

            const liveSheet = doc.sheetsByTitle['LiveSchedule'];
            for (const l of lives) {
                const { formattedDate, formattedTime } = parseGripDateTime(l.date, l.time);
                await liveSheet.addRow({
                    'Scraped_at': timestamp,
                    'Seller_name': item.name,
                    'Title': l.title,
                    'Date': formattedDate,
                    'Time': formattedTime,
                    'Url': item.url
                });
            }
            console.log(`✅ [${item.name}] 완료`);
        } catch (err) { console.error(`❌ [${item.name}] 에러`); }
    }
    await browser.close();
})();
