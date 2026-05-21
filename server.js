const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const cfb = require('cfb');
const zlib = require('zlib');
const dotenv = require('dotenv');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Serve static frontend files from current directory
app.use(express.static(__dirname));

// Multer configurations (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // Limit to 10MB per file
});

// Sleep utility function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 🔒 개인정보 로컬 마스킹 함수 (전체 정규식 매칭)
 * @param {string} text 원본 텍스트
 * @returns {string} 마스킹 처리된 안전한 텍스트
 */
function maskPersonalInfo(text) {
  if (!text) return '';

  let maskedText = text;

  // 1. 휴대폰 번호 및 일반 전화번호 마스킹
  const phoneRegex = /(010|02|0[3-9]{1}[0-9]{1,2})[-. ]?[0-9]{3,4}[-. ]?[0-9]{4}/g;
  maskedText = maskedText.replace(phoneRegex, '[전화번호 마스킹]');

  // 2. 이메일 주소 마스킹
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  maskedText = maskedText.replace(emailRegex, '[이메일 마스킹]');

  // 3. 주소지의 상세 주소 마스킹
  const detailPatterns = [
    /\b\d+[-~]\d+(?:번지)?\b/g,
    /\b\d+번지\b/g,
    /(?:[가-힣a-zA-Z0-9]+(?:아파트|빌라|맨션|원룸|오피스텔|타워|캐슬|자이|래미안|푸르지오|아이파크|힐스테이트|더샵|e편한세상))[\s]*\d*(?:동)?[\s]*\d*(?:호|층)?/g,
    /\b\d+동\s*\d+호\b/g,
    /\b\d+호\b/g,
    /\b\d+층\b/g,
    /(?:[가-힣\d]+(?:로|길))[\s]*\d+[-~]?\d*/g
  ];

  detailPatterns.forEach(pattern => {
    maskedText = maskedText.replace(pattern, '[상세주소 마스킹]');
  });

  // 주민번호 마스킹
  const juminRegex = /\d{6}[-. ]?[1-4]\d{6}/g;
  maskedText = maskedText.replace(juminRegex, '[주민번호 마스킹]');

  return maskedText;
}

/**
 * 📄 한글 HWP 5.0 OLE 포맷의 압축 해제 및 유니코드 복원 파서
 * @param {Buffer} buffer HWP 파일 버퍼
 * @returns {string} 복원된 텍스트
 */
function parseHwp(buffer) {
  try {
    const file = cfb.read(buffer, { type: 'buffer' });
    let fullText = '';

    const paths = file.FileIndex.map(x => x.name);
    const sectionPaths = paths.filter(p => p.includes('BodyText/Section'));
    
    if (sectionPaths.length === 0) {
      throw new Error('본문 데이터(BodyText) 섹션이 존재하지 않는 문서입니다.');
    }

    sectionPaths.sort((a, b) => {
      const numA = parseInt(a.replace(/.*Section(\d+)/, '$1'), 10);
      const numB = parseInt(b.replace(/.*Section(\d+)/, '$1'), 10);
      return numA - numB;
    });

    for (const sectionPath of sectionPaths) {
      const entry = file.FileIndex.find(x => x.name === sectionPath);
      if (!entry || !entry.content) continue;
      
      const rawData = Buffer.from(entry.content);
      
      let decompressed;
      try {
        decompressed = zlib.inflateRawSync(rawData);
      } catch (err) {
        decompressed = rawData;
      }

      const utf16String = decompressed.toString('utf-16le');
      
      let cleanText = '';
      for (let i = 0; i < utf16String.length; i++) {
        const code = utf16String.charCodeAt(i);
        
        if (
          (code >= 0xAC00 && code <= 0xD7A3) || 
          (code >= 0x1100 && code <= 0x11FF) || 
          (code >= 0x3130 && code <= 0x318F) || 
          (code >= 65 && code <= 90) ||         
          (code >= 97 && code <= 122) ||        
          (code >= 48 && code <= 57) ||         
          code === 10 || code === 13 || code === 32 || 
          [44, 46, 63, 33, 40, 41, 45, 47, 58, 95, 64, 126, 43].includes(code)
        ) {
          cleanText += utf16String.charAt(i);
        }
      }
      
      cleanText = cleanText.replace(/\s+/g, ' ');
      fullText += cleanText + '\n';
    }
    
    return fullText;
  } catch (err) {
    console.error('[ERROR] HWP 파싱 실패:', err);
    throw new Error(`한글 HWP 파싱 오류: ${err.message}`);
  }
}

/**
 * ⚡ Gemini API 호출 재시도 래퍼 (503/429 일시적 장애 복원 전용)
 * @param {GoogleGenAI} ai SDK 인스턴스
 * @param {object} params 호출 매개변수
 * @param {number} retries 남은 재시도 횟수
 * @param {number} delay 대기 간격 (ms)
 */
async function generateContentWithRetry(ai, params, retries = 5, delay = 3000) {
  try {
    return await ai.models.generateContent(params);
  } catch (err) {
    const errMsg = err.message || '';
    const isTransientError = 
      errMsg.includes('503') || 
      errMsg.includes('UNAVAILABLE') || 
      errMsg.includes('429') || 
      errMsg.includes('RESOURCE_EXHAUSTED') ||
      errMsg.includes('high demand') ||
      errMsg.includes('temporary') ||
      err.status === 429 ||
      err.statusCode === 429 ||
      (err.status && err.status.toString().includes('429')) ||
      (err.status && err.status.toString().includes('503'));

    if (isTransientError && retries > 0) {
      console.warn(`[WARN] Gemini API 일시적 오류 감지. ${delay}ms 후 재시도합니다... (남은 횟수: ${retries}회, 원인: ${errMsg.substring(0, 60)})`);
      await sleep(delay);
      return generateContentWithRetry(ai, params, retries - 1, delay * 2); // 지수 백오프 적용
    }
    throw err;
  }
}

/**
 * 이력서 버퍼 및 확장자 정보로 텍스트를 추출하는 공통 파서
 */
async function extractTextFromFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    let parsedPdf;
    if (typeof pdfParse === 'function') {
      parsedPdf = await pdfParse(buffer);
    } else if (pdfParse && typeof pdfParse.default === 'function') {
      parsedPdf = await pdfParse.default(buffer);
    } else {
      const pdfFallback = require('pdf-parse/lib/pdf-parse.js');
      parsedPdf = await pdfFallback(buffer);
    }
    return parsedPdf.text;
  } else if (ext === '.docx') {
    const docxResult = await mammoth.extractRawText({ buffer });
    return docxResult.value;
  } else if (ext === '.hwp') {
    return parseHwp(buffer);
  } else {
    throw new Error('지원하지 않는 파일 형식입니다. (PDF, DOCX, HWP만 가능)');
  }
}

// ============================================================================
// 1. 단일 지원자 상세 분석 엔드포인트 (/api/analyze/single)
// ============================================================================
app.post('/api/analyze/single', upload.single('resume'), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'Gemini API 키가 구성되지 않았습니다. .env 파일을 확인해 주세요.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: '업로드된 파일이 없습니다.' });
    }

    const jdDuties = req.body.jdDuties || '';
    const jdRequirements = req.body.jdRequirements || '';
    const jdPreferences = req.body.jdPreferences || '';
    const jdExpYears = req.body.jdExpYears || '';
    const jdAgeLimit = req.body.jdAgeLimit || '';
    const fileName = req.file.originalname;

    console.log(`[INFO] 단일 분석 시작: ${fileName} (${req.file.size} bytes)`);

    // 1단계: 텍스트 추출
    let rawText = '';
    try {
      rawText = await extractTextFromFile(req.file.buffer, fileName);
    } catch (parseErr) {
      console.error(`[ERROR] 파일 파싱 실패:`, parseErr);
      return res.status(500).json({ error: `파일 텍스트 추출 실패: ${parseErr.message}` });
    }

    if (!rawText || rawText.trim().length === 0) {
      return res.status(400).json({ error: '이력서 파일에 텍스트 데이터가 없거나 스캔본 이미지 형식입니다.' });
    }

    // 2단계: 로컬 개인정보 마스킹
    const maskedText = maskPersonalInfo(rawText);

    // 3단계: Gemini 구조화 요청
    const singleResponseSchema = {
      type: "OBJECT",
      properties: {
        name: { type: "STRING" },
        age: { type: "STRING" },
        location: { type: "STRING" },
        total_experience: { type: "STRING" },
        average_tenure: { type: "STRING" },
        match_rate: { type: "STRING" },
        match_reason: { type: "STRING" },
        gap_periods: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              period: { type: "STRING" },
              duration: { type: "STRING" }
            },
            required: ["period", "duration"]
          }
        },
        skills: { type: "ARRAY", items: { type: "STRING" } },
        certifications: { type: "ARRAY", items: { type: "STRING" } },
        career_summary: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              company: { type: "STRING" },
              period: { type: "STRING" },
              role: { type: "STRING" },
              description: { type: "STRING" }
            },
            required: ["company", "period", "description"]
          }
        },
        interview_questions: { type: "ARRAY", items: { type: "STRING" } }
      },
      required: [
        "name", "age", "location", "total_experience", "average_tenure",
        "match_rate", "match_reason", "gap_periods", "skills", "certifications",
        "career_summary", "interview_questions"
      ]
    };

    const systemPrompt = `
당신은 대기업 인사팀의 핵심 서류 스크리닝 전문가이자 채용 총괄관입니다.
지원자의 이력서 텍스트(개인정보가 마스킹된 상태)와 인사팀이 입력한 5가지 세부 채용 기준[주요 업무, 필수 요건, 우대 사항, 필요 경력, 참고 나이]을 엄격하게 대조하여 분석해 주세요.

[엄격 검증 및 매칭률 산출 규칙]
1. 'match_rate' (직무 매칭률) 및 'match_reason' (매칭 사유):
   - 제공된 채용 요건들과 지원자의 이력서를 일대일 비교하여 0%~100% 사이의 백분율 형식 문자열(예: '85%')로 산출해 주세요.
   - **경력 대조**: 지원자의 총 경력 년수가 인사팀이 설정한 [필요 경력 (최소 년수)] 미만일 경우, match_reason에 미달 사실을 명확히 쓰고 match_rate 점수를 강력하게 감점해야 합니다. (예: 최소 3년 필요에 지원자 경력이 1년이면 큰 감점)
   - **나이 대조**: 지원자의 출생연도를 토대로 현재(2026년) 기준 실제 한국 나이를 구하세요. 만약 인사팀이 설정한 [참고 나이 (제한 나이)] 기준이 입력되어 있고 지원자 나이가 이를 초과한다면, match_reason에 이를 명시하고 최종 match_rate 점수에 감점 요인으로 강력하게 반영해야 합니다.
   - match_reason은 강점, 필수/우대조건 충족도, 경력/나이 대조 판별 결과를 한국어로 조리 있게 요약하여 작성해 주세요. 채용 요건들이 비어 있을 경우 match_rate는 '0%', match_reason은 '채용 요건 정보가 입력되지 않았습니다.'로 응답하십시오.
2. 'gap_periods' (공백기 분석):
   - 직장 간의 재직 기간 사이에 발생한 공백이 "3개월 이상"인 구간을 모두 찾으세요. (예: 2021.03 ~ 2021.11, "8개월")
   - 날짜가 겹치거나 공백이 3개월 미만이면 공백기 리스트에 추가하지 마십시오. 공백기가 없으면 빈 배열([])을 반환합니다.
3. 'average_tenure' (평균 이직 주기):
   - 각 직장별 재직 기간의 평균을 구하세요. (예: "1년 6개월", "2년 4개월" 등)
4. 'total_experience' (총 경력 기간):
   - 중복되지 않는 모든 재직 기간을 합산한 총 경력을 구하세요. (예: "4년 2개월", "8년 10개월" 등)
5. 'interview_questions' (추천 면접 질문):
   - 이력서 기반의 맞춤형 면접 추천 질문 3가지를 도출하세요.
   - 만약 3개월 이상의 공백기가 감지되었다면, 그중 최소한 하나 이상의 질문은 공백기 사유 검증 질문(예: "공백기 동안 어떤 경험/활동을 했는지")이어야 합니다.
6. 'location': 거주지를 시/구 단위까지만 추출하십시오. 예: "서울시 마포구", "경기도 성남시".
7. 'age': 출생연도를 추출하고, 현재 연도(2026년) 기준 나이를 계산해 기재하십시오. 예: "1992년생 (만 34세)"
8. 마스킹 가이드라인: 전달된 텍스트 중 "[전화번호 마스킹]" 또는 "[이메일 마스킹]", "[상세주소 마스킹]"으로 표시된 부분은 수정하거나 복원하려 하지 마십시오.

제출된 이력서 데이터:
"""
${maskedText}
"""

인사팀 세부 채용 기준:
- [주요 업무]: ${jdDuties || '제한 없음'}
- [필수 요건]: ${jdRequirements || '제한 없음'}
- [우대 사항]: ${jdPreferences || '제한 없음'}
- [필요 경력 (최소 년수)]: ${jdExpYears ? jdExpYears + '년 이상' : '제한 없음'}
- [참고 나이 (제한 나이)]: ${jdAgeLimit ? jdAgeLimit + '세 이하' : '제한 없음'}
`;

    const ai = new GoogleGenAI({ apiKey });
    const response = await generateContentWithRetry(ai, {
      model: 'gemini-2.0-flash',
      contents: systemPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: singleResponseSchema,
        temperature: 0.1
      }
    });

    const structuredData = JSON.parse(response.text);

    if (!structuredData.name || structuredData.name.trim() === '' || structuredData.name.includes('[마스킹]')) {
      structuredData.name = fileName.replace(/\.[^/.]+$/, "");
    }

    res.json(structuredData);

  } catch (error) {
    console.error('[ERROR] 단일 분석 에러:', error);
    res.status(500).json({ error: `분석 실패: ${error.message}` });
  }
});

// ============================================================================
// 2. 다중 지원자 비교 매트릭스 엔드포인트 (/api/analyze/matrix)
// ============================================================================
app.post('/api/analyze/matrix', upload.array('resumes', 20), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'Gemini API 키가 구성되지 않았습니다. .env 파일을 확인해 주세요.' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '업로드된 파일이 없습니다.' });
    }

    const jdDuties = req.body.jdDuties || '';
    const jdRequirements = req.body.jdRequirements || '';
    const jdPreferences = req.body.jdPreferences || '';
    const jdExpYears = req.body.jdExpYears || '';
    const jdAgeLimit = req.body.jdAgeLimit || '';

    const matrixResponseSchema = {
      type: "OBJECT",
      properties: {
        name: { type: "STRING" },
        match_rate: { type: "STRING" },
        total_experience: { type: "STRING" },
        average_tenure: { type: "STRING" },
        skills: { 
          type: "ARRAY", 
          items: { type: "STRING" } 
        },
        summary: { type: "STRING" }
      },
      required: ["name", "match_rate", "total_experience", "average_tenure", "skills", "summary"]
    };

    const ai = new GoogleGenAI({ apiKey });
    const results = [];

    // 개별 파일 처리 루프
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileName = file.originalname;

      if (i > 0) {
        await sleep(2000); // 2000ms Throttle 딜레이
      }

      try {
        const extractedText = await extractTextFromFile(file.buffer, fileName);

        if (!extractedText || extractedText.trim().length === 0) {
          results.push({ name: fileName, match_rate: "0%", total_experience: "-", average_tenure: "-", skills: [], summary: "텍스트 추출 불가 (스캔 파일 가능성)" });
          continue;
        }

        const maskedText = maskPersonalInfo(extractedText);

        const systemPrompt = `
당신은 대기업 인사팀의 핵심 서류 스크리닝 전문가이자 채용 총괄관입니다.
지원자의 이력서 텍스트(개인정보가 마스킹된 상태)와 인사팀이 입력한 5가지 세부 채용 기준[주요 업무, 필수 요건, 우대 사항, 필요 경력, 참고 나이]을 엄격하게 대조하여 분석해 주세요.

[엄격 검증 및 매칭률 산출 규칙]
1. match_rate는 '85%'와 같이 0%에서 100% 사이의 백분율 형식 문자열이어야 합니다.
   - **경력 대조**: 지원자의 총 경력 년수가 인사팀이 설정한 [필요 경력 (최소 년수)] 미만일 경우, summary에 미달 사실을 명확히 기재하고 최종 match_rate 점수를 강력하게 감점해야 합니다.
   - **나이 대조**: 지원자의 출생연도를 토대로 현재(2026년) 기준 실제 한국 나이를 구하세요. 만약 인사팀이 설정한 [참고 나이 (제한 나이)] 기준이 입력되어 있고 지원자 나이가 이를 초과한다면, summary에 초과 사실을 명시하고 최종 match_rate 점수에 감점 요인으로 강력하게 반영해야 합니다.
2. total_experience는 중복되지 않는 모든 재직 기간을 합산한 총 경력을 구하세요. (예: "4년 2개월", "8년 10개월" 등)
3. average_tenure는 각 직장별 재직 기간의 평균을 구하세요. (예: "1년 6개월", "2년 4개월" 등)
4. skills는 이력서에서 추출된 핵심 기술 스킬이나 주요 역량을 단어 배열로 나열해 주세요. (최대 6개)
5. summary는 이력서와 JD를 비교했을 때의 핵심 강점, 부족한 점(나이/경력 기준 부합 여부 포함)을 요약한 한줄 의견을 한국어로 작성해 주세요. (1~2문장 이내)

[이력서 텍스트]
${maskedText}

[인사팀 세부 채용 기준]
- 주요 업무: ${jdDuties || '제한 없음'}
- 필수 요건: ${jdRequirements || '제한 없음'}
- 우대 사항: ${jdPreferences || '제한 없음'}
- 필요 경력 (최소 년수): ${jdExpYears ? jdExpYears + '년 이상' : '제한 없음'}
- 참고 나이 (제한 나이): ${jdAgeLimit ? jdAgeLimit + '세 이하' : '제한 없음'}
`;

        const response = await generateContentWithRetry(ai, {
          model: 'gemini-2.0-flash',
          contents: systemPrompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: matrixResponseSchema,
            temperature: 0.1
          }
        });

        const structuredData = JSON.parse(response.text);
        
        if (!structuredData.name || structuredData.name.trim() === '' || structuredData.name.includes('[마스킹]')) {
          structuredData.name = fileName.replace(/\.[^/.]+$/, "");
        }

        results.push(structuredData);

      } catch (fileErr) {
        console.error(`[ERROR] 파일 처리 실패 (${fileName}):`, fileErr);

        let friendlyMessage = "분석 실패 (알 수 없는 오류)";
        const errMsg = fileErr.message || '';
        
        if (errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('high demand')) {
          friendlyMessage = "구글 API 서버 일시적 과부하 (잠시 후 다시 시도)";
        } else if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
          friendlyMessage = "API 요청 한도 초과 (잠시 후 다시 시도)";
        } else if (errMsg.includes('API key') || errMsg.includes('API 키')) {
          friendlyMessage = "인증 실패 (API 키 설정을 확인해 주세요)";
        } else {
          friendlyMessage = `분석 실패: ${errMsg.substring(0, 80)}`;
        }

        results.push({
          name: fileName,
          match_rate: "오류",
          total_experience: "-",
          average_tenure: "-",
          skills: [],
          summary: friendlyMessage
        });
      }
    }

    res.json({ results });

  } catch (error) {
    console.error('[ERROR] 다중 분석 실패:', error);
    res.status(500).json({ error: '서버 내부 처리 오류: ' + error.message });
  }
});

// 기본 경로 index.html 서빙
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Express 서버 가동
app.listen(port, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  보안 안심형 통합 이력서 대시보드 서버가 가동되었습니다.`);
  console.log(`  주소: http://localhost:${port}`);
  console.log(`=======================================================`);
});