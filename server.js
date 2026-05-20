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
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Serve static frontend files from current directory
app.use(express.static(__dirname));

// Multer storage configuration (PDF, DOCX, HWP parsing)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // Limit to 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = ['.pdf', '.docx', '.hwp'];
    
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('PDF, Word(.docx), 한글(.hwp) 파일만 업로드할 수 있습니다.'));
    }
  }
});

/**
 * 2. 최우선 보안 로직: 개인정보 로컬 마스킹 함수
 * @param {string} text 원본 텍스트
 * @returns {string} 마스킹 처리된 안전한 텍스트
 */
function maskPersonalInfo(text) {
  if (!text) return '';

  let maskedText = text;

  // 1. 휴대폰 번호 및 일반 전화번호 마스킹
  const phoneRegex = /(010|02|0[3-9]{1}[0-9]{1,2})[-. ]?[0-9]{3,4}[-. ]?[0-9]{4}/g;
  maskedText = maskedText.replace(phoneRegex, '[전화번호 보안 마스킹]');

  // 2. 이메일 주소 마스킹
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  maskedText = maskedText.replace(emailRegex, '[이메일 보안 마스킹]');

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
    maskedText = maskedText.replace(pattern, '[상세주소 보안 마스킹]');
  });

  // 주민번호 마스킹
  const juminRegex = /\d{6}[-. ]?[1-4]\d{6}/g;
  maskedText = maskedText.replace(juminRegex, '[주민번호 보안 마스킹]');

  return maskedText;
}

/**
 * HWP 5.0 OLE 파일 텍스트 추출 로컬 파싱 함수 (압축 데이터 해제 포함)
 * @param {Buffer} buffer HWP 파일 버퍼
 * @returns {string} 추출 및 정제된 한글/영문 텍스트
 */
function parseHwp(buffer) {
  try {
    // 1. CFB를 사용하여 OLE 컨테이너 로드
    const file = cfb.read(buffer, { type: 'buffer' });
    let fullText = '';

    // FileIndex 내의 파일 경로 수집
    const paths = file.FileIndex.map(x => x.name);
    
    // 2. HWP 이력서의 본문이 담긴 BodyText 섹션들 추출
    const sectionPaths = paths.filter(p => p.includes('BodyText/Section'));
    
    if (sectionPaths.length === 0) {
      throw new Error('이력서 파일에서 본문 섹션(BodyText)을 찾을 수 없습니다.');
    }

    // 3. Section 정렬 (Section0, Section1, ...)
    sectionPaths.sort((a, b) => {
      const numA = parseInt(a.replace(/.*Section(\d+)/, '$1'), 10);
      const numB = parseInt(b.replace(/.*Section(\d+)/, '$1'), 10);
      return numA - numB;
    });

    // 4. 각 Section에 접근하여 데이터 복원
    for (const sectionPath of sectionPaths) {
      const entry = file.FileIndex.find(x => x.name === sectionPath);
      if (!entry || !entry.content) continue;
      
      const rawData = Buffer.from(entry.content);
      
      // HWP의 각 Section 스트림은 Deflate 알고리즘으로 압축되어 있는 것이 규격
      let decompressed;
      try {
        decompressed = zlib.inflateRawSync(rawData);
      } catch (err) {
        // 간혹 압축이 되어 있지 않은 특수 포맷의 경우 원본 버퍼 유지
        decompressed = rawData;
      }

      // HWP 5.0 본문 텍스트는 UTF-16LE 형태로 인코딩되어 저장됨
      const utf16String = decompressed.toString('utf-16le');
      
      // 5. 바이너리 제어문자를 소거하고 한국어, 영어, 숫자, 기본 기호 및 띄어쓰기만 스크러빙
      let cleanText = '';
      for (let i = 0; i < utf16String.length; i++) {
        const code = utf16String.charCodeAt(i);
        
        if (
          (code >= 0xAC00 && code <= 0xD7A3) || // 한글 가~힣
          (code >= 0x1100 && code <= 0x11FF) || // 한글 자모
          (code >= 0x3130 && code <= 0x318F) || // 한글 호환 자모
          (code >= 65 && code <= 90) ||         // 영문 대문자
          (code >= 97 && code <= 122) ||        // 영문 소문자
          (code >= 48 && code <= 57) ||         // 숫자
          code === 10 || code === 13 || code === 32 || // 줄바꿈, 스페이스
          [44, 46, 63, 33, 40, 41, 45, 47, 58, 95, 64, 126, 43].includes(code) // 기본 특수기호 (, . ? ! ( ) - / : _ @ ~ +)
        ) {
          cleanText += utf16String.charAt(i);
        }
      }
      
      // 무분별한 다중 공백은 하나로 축소
      cleanText = cleanText.replace(/\s+/g, ' ');
      fullText += cleanText + '\n';
    }
    
    return fullText;
  } catch (err) {
    console.error('[ERROR] HWP 파싱 실패:', err);
    throw new Error(`한글(HWP) 이력서 파일 텍스트 추출 중 오류가 발생했습니다: ${err.message}`);
  }
}

// REST API 엔드포인트: 이력서 파일 업로드 및 분석 (PDF, Word, HWP 공용)
app.post('/api/analyze', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '업로드된 파일이 없습니다.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      return res.status(400).json({
        error: 'Gemini API 키가 구성되지 않았습니다. 프로젝트 루트의 .env 파일에 GEMINI_API_KEY를 입력해 주세요.'
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    console.log(`[INFO] 이력서 분석 시작: ${req.file.originalname} (${req.file.size} bytes, 포맷: ${ext})`);

    // 1단계: 확장자에 따른 파일 텍스트 추출 분기 처리
    let rawText = '';
    
    try {
      if (ext === '.pdf') {
        // pdf-parse의 로드 및 호출 방식을 방어적으로 처리 (pdfParse is not a function 에러 원천 방지)
        let parsedPdf;
        if (typeof pdfParse === 'function') {
          parsedPdf = await pdfParse(req.file.buffer);
        } else if (pdfParse && typeof pdfParse.default === 'function') {
          parsedPdf = await pdfParse.default(req.file.buffer);
        } else if (pdfParse && typeof pdfParse.pdfParse === 'function') {
          parsedPdf = await pdfParse.pdfParse(req.file.buffer);
        } else {
          // 최후의 보루: 패키지 내부 모듈 직접 호출
          const pdfFallback = require('pdf-parse/lib/pdf-parse.js');
          parsedPdf = await pdfFallback(req.file.buffer);
        }
        
        rawText = parsedPdf.text;
      } else if (ext === '.docx') {
        const docxResult = await mammoth.extractRawText({ buffer: req.file.buffer });
        rawText = docxResult.value;
      } else if (ext === '.hwp') {
        rawText = parseHwp(req.file.buffer);
      } else {
        return res.status(400).json({ error: '지원하지 않는 파일 형식입니다. PDF, DOCX, HWP 형식만 가능합니다.' });
      }
    } catch (parseErr) {
      console.error(`[ERROR] 파일 파싱 실패 (${ext}):`, parseErr);
      return res.status(500).json({ error: `이력서 파일에서 텍스트를 추출하는 데 실패했습니다: ${parseErr.message}` });
    }

    if (!rawText || rawText.trim().length === 0) {
      return res.status(400).json({ error: '이력서 파일에 텍스트 데이터가 없거나 인식할 수 없는 이미지/스캔본 형식입니다.' });
    }

    console.log(`[INFO] 텍스트 추출 완료 (${rawText.length} 자)`);

    // 2단계: 최우선 보안 로직 - 개인정보 로컬 마스킹 처리 (모든 포맷 공통 적용)
    const maskedText = maskPersonalInfo(rawText);
    console.log('[INFO] 로컬 전처리 마스킹 처리 완료');

    // 3단계: Gemini API 연동을 통한 데이터 구조화 및 공백기 분석
    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `
당신은 기업의 전문 인사기획팀 소속 커리어 분석관 및 채용 전문가입니다.
지원자의 이력서 텍스트(개인정보가 마스킹된 상태)를 분석하여 경력 구조를 체계적으로 파악하고, 직장 간의 공백기를 계산하며, 맞춤형 질문을 도출해야 합니다.

다음 규칙을 엄격하게 준수하여 분석을 수행해 주세요:
1. 'gap_periods' (공백기 분석):
   - 직장 간의 재직 기간 사이에 발생한 공백이 "3개월 이상"인 구간을 모두 찾으세요.
   - 예: 이전 직장 퇴사일이 2021년 2월이고 다음 직장 입사일이 2021년 10월이면 약 8개월의 공백기가 존재하므로, 이를 [{"period": "2021.03 ~ 2021.10", "duration": "8개월"}] 형태로 포함해야 합니다.
   - 날짜가 겹치거나 공백이 3개월 미만이면 공백기 리스트에 추가하지 마십시오. 공백기가 없으면 빈 배열([])을 반환합니다.
2. 'average_tenure' (평균 이직 주기):
   - 각 직장별 재직 기간의 평균을 구하세요. (예: 1개 직장에 평균적으로 머무는 기간. 예: "1년 6개월", "2년 4개월" 등)
3. 'total_experience' (총 경력 기간):
   - 중복되지 않는 모든 재직 기간을 합산한 총 경력을 명확한 문자열 형식으로 구하세요. (예: "4년 2개월", "8년 10개월" 등)
4. 'interview_questions' (추천 면접 질문):
   - 이력서 기반의 맞춤형 면접 추천 질문 3가지를 도출하세요.
   - 만약 3개월 이상의 공백기가 감지되었다면, 그중 최소한 하나 이상의 질문은 공백기 사유 검증 질문(예: "공백기 동안 어떤 경험/활동을 했는지")이어야 합니다.
5. 'location': 거주지를 시/구 단위까지만 추출하십시오. 예: "서울시 마포구", "경기도 성남시". 상세 정보는 제외합니다.
6. 'age': 출생연도를 추출하고, 현재 연도(2026년) 기준 나이를 계산해 기재하십시오. 예: "1992년생 (만 34세)"
7. 마스킹 가이드라인: 전달된 텍스트 중 "[전화번호 보안 마스킹]" 또는 "[이메일 보안 마스킹]", "[상세주소 보안 마스킹]"으로 표시된 부분은 수정하거나 추측하여 복원하지 말고 그대로 보존하거나 공백으로 처리하세요.

제출된 이력서 데이터:
"""
${maskedText}
"""
`;

    // Structured Output Schema 정의
    const jsonSchema = {
      type: "OBJECT",
      properties: {
        name: { type: "STRING" },
        age: { type: "STRING" },
        location: { type: "STRING" },
        total_experience: { type: "STRING" },
        average_tenure: { type: "STRING" },
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
        "gap_periods", "skills", "certifications", "career_summary", "interview_questions"
      ]
    };

    console.log('[INFO] Gemini API 호출 중...');
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: systemPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        temperature: 0.1
      }
    });

    const responseText = response.text;
    console.log('[INFO] Gemini API 응답 수신 완료');

    const structuredData = JSON.parse(responseText);
    res.json(structuredData);

  } catch (error) {
    console.error('[ERROR] 요청 처리 실패:', error);
    res.status(500).json({
      error: `서버 처리 중 오류가 발생했습니다: ${error.message}`
    });
  }
});

// 기본 루트 경로: index.html 서빙
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Express 서버 실행
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  보안 안심형 멀티포맷 이력서 분석기 서버가 가동되었습니다.`);
  console.log(`  지원 형식: PDF, DOCX(Word), HWP(한글)`);
  console.log(`  주소: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});