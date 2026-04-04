const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

// 한국 시간(KST) 객체를 생성하는 헬퍼 함수
function getKSTDate() {
    const curr = new Date();
    const utc = curr.getTime() + (curr.getTimezoneOffset() * 60 * 1000);
    const KR_TIME_DIFF = 9 * 60 * 60 * 1000;
    return new Date(utc + KR_TIME_DIFF);
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

// 날짜 파싱 (오늘, 내일, 요일 등) - 한국 시간 기준 적용
function parseGripDateTime(dateStr, timeStr) {
    const nowKST = getKSTDate();
    let targetDate = new Date(nowKST);
    
    if (dateStr.includes('내일')) {
        targetDate.setDate(nowKST.getDate() + 1);
    } else if (dateStr.includes('요일')) {
        const days = ['일','월','화','수','목','금','토'];
        const currentDay = nowKST.getDay();
        const targetDay = days.indexOf(dateStr.replace('요일','').trim());
        const diff = (targetDay - currentDay + 7) % 7 || 7;
        targetDate.setDate(nowKST.getDate() + diff);
    }
    
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    
    return { 
        formattedDate: `${yyyy}${mm}${dd}`, 
        formattedTime: timeStr.replace(/[^0-9:]/g, '') 
    };
}

// 소식 날짜 추정 (3일 전 등) - 한국 시간 기준 적용
function parseStoryDate(dateStr) {
    const nowKST = getKSTDate();
    let targetDate = new Date(nowKST);
    const value = parseInt(dateStr.replace(/[^0-9]/g, '')) || 0;
    
    if (dateStr.includes('시간')) targetDate.setHours(nowKST.getHours() - value);
    else if (dateStr.includes('일')) targetDate.setDate(nowKST.getDate() - value);
    else if (dateStr.includes('주')) targetDate.setDate(nowKST.getDate() - (value * 7));
    
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    
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
            const nowKST = getKSTDate();
            const timestamp = nowKST.toLocaleString('ko-KR');

            for (const s of stories) {
                if (!s.content) continue;
                const fDate = parseStoryDate(s.rawDate);
                await storySheet.addRow({
                    'Scraped_at': timestamp,
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
                    'Scraped_at': timestamp,
                    'Seller_name': item.name,
                    'Title': l.title,
                    'Date': formattedDate,
                    'Time': formattedTime,
                    'Url': item.url
                });
            }
            console.log(`✅ [${item.name}] 완료`);
        } catch (err) { 
            console.error(`❌ [${item.name}] 에러: ${err.message}`); 
        }
    }
    await browser.close();
})();
