const { chromium } = require('playwright');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1EHOG5WEbnvilAw-s4zS-ttMbQDFdDXwMjFpnx5JRVPk';

function getDoc() {
    let credentials = null;

    // 1. 로컬 환경 확인: secret.json 파일이 있는지 먼저 시도
    try {
        credentials = require('./secret.json');
    } catch (err) {
        // 파일이 없는 경우(MODULE_NOT_FOUND)는 정상적인 시나리오(CI/CD 환경 등)이므로 무시
        if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }

    // 2. 환경 변수 확인: 파일이 없으면 GOOGLE_CREDS(JSON 문자열) 확인
    if (!credentials && process.env.GOOGLE_CREDS) {
        try {
            credentials = JSON.parse(process.env.GOOGLE_CREDS);
        } catch (err) {
            throw new Error('GOOGLE_CREDS 환경 변수가 올바른 JSON 형식이 아닙니다.');
        }
    }

    // 3. 개별 환경 변수 확인: 개별 키(Email, Key)가 설정되어 있는지 확인
    if (!credentials) {
        const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
        const privateKey = process.env.GOOGLE_PRIVATE_KEY;

        if (clientEmail && privateKey) {
            credentials = {
                client_email: clientEmail,
                private_key: privateKey.replace(/\\n/g, '\n') // 개행 문자 처리
            };
        }
    }

    // 최종 검증: 모든 수단을 동원해도 인증 정보가 없으면 에러
    if (!credentials || !credentials.client_email || !credentials.private_key) {
        throw new Error(
            '인증 정보를 찾을 수 없습니다. (secret.json 파일, GOOGLE_CREDS, 또는 개별 환경 변수를 설정해주세요.)'
        );
    }

    // JWT 객체 생성 및 GoogleSpreadsheet 인스턴스 반환
    const serviceAccountAuth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
}

function formatDate(date) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

function getKstNowDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(new Date());

    const data = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return new Date(Date.UTC(
        Number(data.year),
        Number(data.month) - 1,
        Number(data.day),
        Number(data.hour),
        Number(data.minute),
        Number(data.second)
    ));
}

function formatKstDateTime(date = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date);
}

function parseTimeTo24Hour(timeStr) {
    const normalized = String(timeStr || '').trim();
    if (!normalized) return '';

    const meridiemMatch = normalized.match(/(오전|오후|아침|점심|저녁|밤|새벽|am|pm)/i);
    const timeMatch = normalized.match(/(\d{1,2})(?::(\d{1,2}))?/);
    if (!timeMatch) return String(normalized).replace(/[^0-9:]/g, '');

    let hour = parseInt(timeMatch[1], 10);
    let minute = parseInt(timeMatch[2] || '0', 10);
    if (Number.isNaN(hour) || Number.isNaN(minute) || minute < 0 || minute > 59) return '';

    const meridiem = (meridiemMatch?.[1] || '').toLowerCase();
    const isPm = ['오후', '점심', '저녁', '밤', 'pm'].includes(meridiem);
    const isAm = ['오전', '아침', '새벽', 'am'].includes(meridiem);

    if (isPm && hour < 12) hour += 12;
    if (isAm && hour === 12) hour = 0;

    if (hour < 0 || hour > 23) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 날짜 파싱 (오늘, 내일, 요일 등)
function parseGripDateTime(dateStr, timeStr) {
    const now = getKstNowDate();
    let targetDate = new Date(now);
    const normalized = String(dateStr || '').trim();
    if (/오늘/.test(normalized)) {
        // today
    } else if (/내일/.test(normalized)) {
        targetDate.setUTCDate(now.getUTCDate() + 1);
    } else if (/요일/.test(normalized)) {
        const days = ['일', '월', '화', '수', '목', '금', '토'];
        const dayText = normalized.replace('요일', '').trim();
        const diff = (days.indexOf(dayText) - now.getUTCDay() + 7) % 7 || 7;
        targetDate.setUTCDate(now.getUTCDate() + diff);
    }
    return { formattedDate: formatDate(targetDate), formattedTime: parseTimeTo24Hour(timeStr) };
}

// 소식 날짜 추정 (어제, 오늘, 3일 전, 2026년 1월 20일 등)
function parseStoryDate(dateStr) {
    const now = getKstNowDate();
    let targetDate = new Date(now);
    const normalized = String(dateStr || '').trim();
    if (!normalized) return formatDate(now);

    if (/오늘/.test(normalized)) {
        return formatDate(now);
    }
    if (/어제/.test(normalized)) {
        targetDate.setUTCDate(now.getUTCDate() - 1);
        return formatDate(targetDate);
    }
    if (/그제/.test(normalized)) {
        targetDate.setUTCDate(now.getUTCDate() - 2);
        return formatDate(targetDate);
    }
    if (/([0-9]+)분/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)분/)[1], 10);
        targetDate.setUTCMinutes(now.getUTCMinutes() - value);
        return formatDate(targetDate);
    }
    if (/([0-9]+)시간/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)시간/)[1], 10);
        targetDate.setUTCHours(now.getUTCHours() - value);
        return formatDate(targetDate);
    }
    if (/([0-9]+)일 전/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)일 전/)[1], 10);
        targetDate.setUTCDate(now.getUTCDate() - value);
        return formatDate(targetDate);
    }
    if (/([0-9]+)주 전/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)주 전/)[1], 10);
        targetDate.setUTCDate(now.getUTCDate() - value * 7);
        return formatDate(targetDate);
    }
    if (/([0-9]+)개월 전/.test(normalized)) {
        const value = parseInt(normalized.match(/([0-9]+)개월 전/)[1], 10);
        targetDate.setUTCMonth(now.getUTCMonth() - value);
        return formatDate(targetDate);
    }
    const fullDateMatch = normalized.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
    if (fullDateMatch) {
        const year = parseInt(fullDateMatch[1], 10);
        const month = parseInt(fullDateMatch[2], 10) - 1;
        const day = parseInt(fullDateMatch[3], 10);
        targetDate = new Date(Date.UTC(year, month, day));
        return formatDate(targetDate);
    }
    const slashDateMatch = normalized.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
    if (slashDateMatch) {
        const year = parseInt(slashDateMatch[1], 10);
        const month = parseInt(slashDateMatch[2], 10) - 1;
        const day = parseInt(slashDateMatch[3], 10);
        targetDate = new Date(Date.UTC(year, month, day));
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

function buildLiveKey(sellerName, date, time) {
    const normalizedSeller = String(sellerName || '').trim();
    const normalizedDate = String(date || '').trim();
    const normalizedTime = String(time || '').trim();
    return `${normalizedSeller}|${normalizedDate}|${normalizedTime}`;
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
    const liveSheet = doc.sheetsByTitle['LiveSchedule'];
    const liveExistingRows = await liveSheet.getRows();
    const liveExistingKeys = new Set(
        liveExistingRows.map(r => buildLiveKey(r.get('Seller_name'), r.get('Date'), r.get('Time')))
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
                    'Scraped_at': formatKstDateTime(),
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

            let liveSavedCount = 0;
            let liveSkippedCount = 0;
            for (const l of liveResult.parsedItems) {
                const { formattedDate, formattedTime } = parseGripDateTime(l.date, l.time);
                const liveKey = buildLiveKey(item.name, formattedDate, formattedTime);
                if (liveExistingKeys.has(liveKey)) {
                    console.log(`   ↩️ [Live] 중복 건너뜀 date="${formattedDate}" time="${formattedTime}"`);
                    liveSkippedCount += 1;
                    continue;
                }
                console.log(`   [Live] title="${l.title.substring(0, 50)}" date="${l.date}" time="${l.time}" -> ${formattedDate} ${formattedTime}`);
                await liveSheet.addRow({
                    'Scraped_at': formatKstDateTime(),
                    'Seller_name': item.name,
                    'Title': l.title,
                    'Date': formattedDate,
                    'Time': formattedTime,
                    'Url': item.url
                });
                liveExistingKeys.add(liveKey);
                liveSavedCount += 1;
            }
            if (liveResult.parsedItems.length === 0) {
                console.log(`   ⚠️ live 항목 없음 또는 schedule-cover 미발견`);
            }
            console.log(`   ✅ live 저장: ${liveSavedCount}개 (중복 스킵: ${liveSkippedCount}개)`);
            console.log(`✅ [${item.name}] 완료`);
        } catch (err) { console.error(`❌ [${item.name}] 에러`, err.message); }
    }
    await browser.close();
})();
