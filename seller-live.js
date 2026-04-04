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

// 날짜 파싱 (오늘, 내일, 요일 등)
function parseGripDateTime(dateStr, timeStr) {
    const now = new Date();
    let targetDate = new Date(now);
    if (dateStr.includes('내일')) targetDate.setDate(now.getDate() + 1);
    else if (dateStr.includes('요일')) {
        const days = ['일','월','화','수','목','금','토'];
        const diff = (days.indexOf(dateStr.replace('요일','').trim()) - now.getDay() + 7) % 7 || 7;
        targetDate.setDate(now.getDate() + diff);
    }
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth()+1).padStart(2,'0');
    const dd = String(targetDate.getDate()).padStart(2,'0');
    return { formattedDate: `${yyyy}${mm}${dd}`, formattedTime: timeStr.replace(/[^0-9:]/g, '') };
}

// 소식 날짜 추정 (3일 전 등)
function parseStoryDate(dateStr) {
    const now = new Date();
    let targetDate = new Date(now);
    const value = parseInt(dateStr.replace(/[^0-9]/g, '')) || 0;
    if (dateStr.includes('시간')) targetDate.setHours(now.getHours() - value);
    else if (dateStr.includes('일')) targetDate.setDate(now.getDate() - value);
    else if (dateStr.includes('주')) targetDate.setDate(now.getDate() - (value * 7));
    
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth()+1).padStart(2,'0');
    const dd = String(targetDate.getDate()).padStart(2,'0');
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
                const fDate = parseStoryDate(s.rawDate);
                await storySheet.addRow({
                    'Scraped_at': new Date().toLocaleString(),
                    'Seller_name': item.name,
                    'Content': s.content,
                    'Date': fDate,
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
                    'Scraped_at': new Date().toLocaleString(),
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