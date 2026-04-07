const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

function getDoc() {
    const credentials = require('./secret.json');

    return new GoogleSpreadsheet(SPREADSHEET_ID, new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }));
}

function formatDate(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

// 날짜 파싱 (오늘, 내일, 요일 등)
function parseGripDateTime(dateStr, timeStr) {
    const now = new Date();
    let targetDate = new Date(now);
    const normalized = String(dateStr || '').trim();
    if (/오늘/.test(normalized)) {
        // today
    } else if (/내일/.test(normalized)) {
        targetDate.setDate(now.getDate() + 1);
    } else if (/요일/.test(normalized)) {
        const days = ['일','월','화','수','목','금','토'];
        const dayText = normalized.replace('요일','').trim();
        const diff = (days.indexOf(dayText) - now.getDay() + 7) % 7 || 7;
        targetDate.setDate(now.getDate() + diff);
    }
    return { formattedDate: formatDate(targetDate), formattedTime: String(timeStr || '').replace(/[^0-9:]/g, '') };
}

// 소식 날짜 추정 (어제, 오늘, 3일 전, 2026년 1월 20일 등)
function parseStoryDate(dateStr) {
    const now = new Date();
    let targetDate = new Date(now);
    const normalized = String(dateStr || '').trim();
    if (!normalized) return formatDate(now);

    if (/오늘/.test(normalized)) {
        return formatDate(now);
    }
    if (/어제/.test(normalized)) {
        targetDate.setDate(now.getDate() - 1);
        return formatDate(targetDate);
    }
    if (/그제/.test(normalized)) {
        targetDate.setDate(now.getDate() - 2);
        return formatDate(targetDate);
    }
    if (/([0-9]+)분/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)분/)[1], 10);
        targetDate.setMinutes(now.getMinutes() - value);
        return formatDate(targetDate);
    }
    if (/([0-9]+)시간/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)시간/)[1], 10);
        targetDate.setHours(now.getHours() - value);
        return formatDate(targetDate);
    }
    if (/([0-9]+)일 전/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)일 전/)[1], 10);
        targetDate.setDate(now.getDate() - value);
        return formatDate(targetDate);
    }
    if (/([0-9]+)주 전/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)주 전/)[1], 10);
        targetDate.setDate(now.getDate() - value * 7);
        return formatDate(targetDate);
    }
    if (/([0-9]+)개월 전/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)개월 전/)[1], 10);
        targetDate.setMonth(now.getMonth() - value);
        return formatDate(targetDate);
    }
    const fullDateMatch = normalized.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
    if (fullDateMatch) {
        const year = parseInt(fullDateMatch[1], 10);
        const month = parseInt(fullDateMatch[2], 10) - 1;
        const day = parseInt(fullDateMatch[3], 10);
        targetDate = new Date(year, month, day);
        return formatDate(targetDate);
    }
    const slashDateMatch = normalized.match(/(\d{4})[-.\/](\d{1,2})[-.\/](1,2})/);
    if (slashDateMatch) {
        const year = parseInt(slashDateMatch[1], 10);
        const month = parseInt(slashDateMatch[2], 10) - 1;
        const day = parseInt(slashDateMatch[3], 10);
        targetDate = new Date(year, month, day);
        return formatDate(targetDate);
    }
    return formatDate(now);
}

function buildStoryKey(sellerName, content, date) {
    const normalizedSeller = String(sellerName || '').trim();
    const normalizedContent = String(content || '').replace(/\s+/g, ' ').trim();
    const normalizedDate = String(date || '').trim();
    return `${normalizedSeller}|${normalizedContent}|${normalizedDate}`;
}

(async () => {
    const doc = getDoc();
    await doc.loadInfo();
    const targetRows = await doc.sheetsByTitle['TargetURLs'].getRows();
    const targetList = targetRows.map(r => ({ name: r.get('Name'), url: r.get('Url') })).filter(i => i.url);

    const storySheet = doc.sheetsByTitle['StoryData'];
    const storyExistingRows = await storySheet.getRows();
    const storyExistingKeys = new Set(
        storyExistingRows.map(r => buildStoryKey(r.get('Seller_name'), r.get('Content'), r.get('Date')))
    );

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-web-security'] });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        locale: 'ko-KR',
        javaScriptEnabled: true,
    });
    const page = await context.newPage();

    for (const item of targetList) {
        try {
            // [소식 수집]
            const storyUrl = item.url.replace('tab=live', 'tab=story');
            console.log(`🔎 [${item.name}] story 페이지 이동: ${storyUrl}`);
            await page.goto(storyUrl, { waitUntil: 'networkidle' });
            const storyResult = await page.evaluate(() => {
                const cards = Array.from(document.querySelectorAll('.story-item.white, .story-item'));
                const items = cards.slice(0, 3).map(card => {
                    const content = card.querySelector('.story-description')?.innerText.split('\n')[0] || "";
                    const rawDate = card.querySelector('.created-at')?.innerText || "";
                    return { content, rawDate };
                });
                return {
                    totalCards: cards.length,
                    items,
                    hasDescription: cards.filter(card => !!card.querySelector('.story-description')).length,
                    hasCreatedAt: cards.filter(card => !!card.querySelector('.created-at')).length,
                };
            });
            console.log(`   📄 story cards total=${storyResult.totalCards}, parsed=${storyResult.items.length}, hasDescription=${storyResult.hasDescription}, hasCreatedAt=${storyResult.hasCreatedAt}`);

            let storySavedCount = 0;
            let storySkippedCount = 0;
            for (const s of storyResult.items) {
                if (!s.content) {
                    console.log(`   ⚠️ [Story] content 없음 rawDate=${s.rawDate}`);
                    continue;
                }
                const fDate = parseStoryDate(s.rawDate);
                const storyKey = buildStoryKey(item.name, s.content, fDate);
                if (storyExistingKeys.has(storyKey)) {
                    console.log(`   ↩️ [Story] 중복 건너뜀 content="${s.content.substring(0, 60)}" date=${fDate}`);
                    storySkippedCount += 1;
                    continue;
                }
                console.log(`   [Story] content="${s.content.substring(0, 60)}" rawDate="${s.rawDate}" -> ${fDate}`);
                await storySheet.addRow({
                    'Scraped_at': new Date().toLocaleString(),
                    'Seller_name': item.name,
                    'Content': s.content,
                    'Date': fDate,
                    'Url': storyUrl
                });
                storyExistingKeys.add(storyKey);
                storySavedCount += 1;
            }
            console.log(`   ✅ story 저장: ${storySavedCount}개 (중복 스킵: ${storySkippedCount}개)`);

            // [라이브 일정 수집]
            console.log(`🔎 [${item.name}] live 페이지 이동: ${item.url}`);
            await page.goto(item.url, { waitUntil: 'networkidle' });
            await page.waitForTimeout(1200);
            const firstLive = await page.waitForSelector('.content-list-item', { timeout: 10000 }).catch(() => null);
            if (!firstLive) {
                console.log(`   ⚠️ .content-list-item를 찾지 못했습니다. DOM 변경 또는 로딩 지연 가능성`);
            } else {
                console.log(`   ✅ .content-list-item 첫 번째 항목 발견`);
            }
            const liveResult = await page.evaluate(() => {
                const contentItems = Array.from(document.querySelectorAll('.content-list-item'));
                const parsedItems = contentItems.map(el => {
                    const sched = el.querySelector('.schedule-cover');
                    return {
                        title: el.querySelector('.title')?.innerText || "",
                        date: sched?.querySelector('.date')?.innerText || "",
                        time: sched?.querySelector('.time')?.innerText || "",
                        hasSchedule: !!sched,
                        html: el.innerHTML.slice(0, 200)
                    };
                });
                return {
                    totalItems: contentItems.length,
                    parsedItems: parsedItems.filter(i => i.hasSchedule),
                    foundScheduleCount: parsedItems.filter(i => i.hasSchedule).length,
                    contentListCount: document.querySelectorAll('.content-list-item').length,
                    scheduleCoverCount: document.querySelectorAll('.content-list-item .schedule-cover').length,
                    sampleItem: parsedItems[0] || null,
                };
            });
            console.log(`   📊 live items total=${liveResult.totalItems}, scheduleCover=${liveResult.scheduleCoverCount}, parsed=${liveResult.parsedItems.length}`);
            if (liveResult.sampleItem) {
                console.log(`   🔎 sample title="${liveResult.sampleItem.title}" date="${liveResult.sampleItem.date}" time="${liveResult.sampleItem.time}" hasSchedule=${liveResult.sampleItem.hasSchedule}`);
            }

            const liveSheet = doc.sheetsByTitle['LiveSchedule'];
            let liveSavedCount = 0;
            for (const l of liveResult.parsedItems) {
                const { formattedDate, formattedTime } = parseGripDateTime(l.date, l.time);
                console.log(`   [Live] title="${l.title.substring(0,50)}" date="${l.date}" time="${l.time}" -> ${formattedDate} ${formattedTime}`);
                await liveSheet.addRow({
                    'Scraped_at': new Date().toLocaleString(),
                    'Seller_name': item.name,
                    'Title': l.title,
                    'Date': formattedDate,
                    'Time': formattedTime,
                    'Url': item.url
                });
                liveSavedCount += 1;
            }
            if (liveResult.parsedItems.length === 0) {
                console.log(`   ⚠️ live 항목 없음 또는 schedule-cover 미발견`);
            }
            console.log(`   ✅ live 저장: ${liveSavedCount}개`);
            console.log(`✅ [${item.name}] 완료`);
        } catch (err) { console.error(`❌ [${item.name}] 에러`, err.message); }
    }
    await browser.close();
})();
