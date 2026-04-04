const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

// 💡 전역에서 사용할 한국 시간 포맷터
const kstFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
});

const kstDateFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit'
});

// 한국 현재 시간을 Date 객체로 반환하는 함수
function getKSTNow() {
    const now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
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
    const nowKST = getKSTNow();
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
    
    // YYYYMMDD 포맷 생성
    const parts = kstDateFormatter.formatToParts(targetDate);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    
    return { 
        formattedDate: `${y}${m}${d}`, 
        formattedTime: timeStr.replace(/[^0-9:]/g, '') 
    };
}

function parseStoryDate(dateStr) {
    const nowKST = getKSTNow();
    let targetDate = new Date(nowKST);
    const value = parseInt(dateStr.replace(/[^0-9]/g, '')) || 0;
    
    if (dateStr.includes('시간')) targetDate.setHours(nowKST.getHours() - value);
    else if (dateStr.includes('일')) targetDate.setDate(nowKST.getDate() - value);
    else if (dateStr.includes('주')) targetDate.setDate(nowKST.getDate() - (value * 7));
    
    const parts = kstDateFormatter.formatToParts(targetDate);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    
    return `${y}${m}${d}`;
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
            const timestamp = kstFormatter.format(new Date()); // 💡 한국 시간대로 포맷팅

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
        } catch (err) { 
            console.error(`❌ [${item.name}] 에러: ${err.message}`); 
        }
    }
    await browser.close();
})();
