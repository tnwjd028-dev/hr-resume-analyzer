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

// Multer configurations for multi-file array
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // Limit to 10MB per file
});

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

// 🚀 다중 파일 비교 매트릭스 API (최대 20개 파일)
app.post('/api/analyze', upload.array('resumes', 20), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'Gemini API 키가 구성되지 않았습니다. .env 파일을 확인해 주세요.' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '업로드된 파일이 없습니다.' });
    }

    const jdText = req.body.jdText || '일반적인 업무 적합성 검토';

    // 1명 분석을 위한 JSON responseSchema 규격
    const responseSchema = {
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

    // 개별 파일 처리 루프 (한 파일 오류 시에도 전체가 무너지지 않도록 try-catch 독립성 부여)
    for (const file of req.files) {
      const fileName = file.originalname;
      const ext = path.extname(fileName).toLowerCase();

      try {
        let extractedText = '';
        
        if (ext === '.pdf') {
          let parsedPdf;
          if (typeof pdfParse === 'function') {
            parsedPdf = await pdfParse(file.buffer);
          } else if (pdfParse && typeof pdfParse.default === 'function') {
            parsedPdf = await pdfParse.default(file.buffer);
          } else {
            const pdfFallback = require('pdf-parse/lib/pdf-parse.js');
            parsedPdf = await pdfFallback(file.buffer);
          }
          extractedText = parsedPdf.text;
        } else if (ext === '.docx') {
          const docxResult = await mammoth.extractRawText({ buffer: file.buffer });
          extractedText = docxResult.value;
        } else if (ext === '.hwp') {
          extractedText = parseHwp(file.buffer);
        } else {
          results.push({ name: fileName, match_rate: "0%", total_experience: "-", average_tenure: "-", skills: [], summary: "지원하지 않는 확장자 포맷" });
          continue;
        }

        if (!extractedText || extractedText.trim().length === 0) {
          results.push({ name: fileName, match_rate: "0%", total_experience: "-", average_tenure: "-", skills: [], summary: "텍스트 추출 불가 (이미지 문서 가능성)" });
          continue;
        }

        // 보안 검증: 개인정보 로컬 마스킹 처리
        const maskedText = maskPersonalInfo(extractedText);

        const systemPrompt = `
당신은 기업의 전문 인사기획팀 소속 커리어 분석관 및 채용 전문가입니다.
제공된 [직무 기술서(JD)]의 필수 요건 및 우대 사항과 지원자의 [이력서 텍스트](개인정보가 마스킹된 상태)를 정밀 비교하여 아래의 JSON 구조로만 분석 결과를 반환해 주세요.

규칙:
1. match_rate는 '85%'와 같이 0%에서 100% 사이의 백분율 형식 문자열이어야 합니다.
2. total_experience는 중복되지 않는 모든 재직 기간을 합산한 총 경력을 명확한 문자열 형식(예: "4년 2개월", "8년 10개월" 등)으로 구하세요.
3. average_tenure는 각 직장별 재직 기간의 평균을 구하세요. (예: "1년 6개월", "2년 4개월" 등)
4. skills는 이력서에서 추출된 핵심 기술 스킬이나 주요 역량을 단어 배열로 나열해 주세요. (최대 6개)
5. summary는 이력서와 JD를 비교했을 때의 핵심 강점과 부족한 점을 요약한 한줄 의견을 한국어로 작성해 주세요. (1~2문장 이내)

[직무 기술서(JD)]
${jdText}

[이력서 텍스트]
${maskedText}
`;

        // Gemini API 호출
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: systemPrompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
            temperature: 0.1
          }
        });

        const structuredData = JSON.parse(response.text);
        
        // 만약 AI가 추출한 name이 없거나 너무 짧으면 파일명을 대리 지정
        if (!structuredData.name || structuredData.name.trim() === '' || structuredData.name.includes('[마스킹]')) {
          structuredData.name = fileName.replace(/\.[^/.]+$/, ""); // 확장자 제거
        }

        results.push(structuredData);

      } catch (fileErr) {
        console.error(`[ERROR] 파일 처리 실패 (${fileName}):`, fileErr);
        results.push({
          name: fileName,
          match_rate: "오류",
          total_experience: "-",
          average_tenure: "-",
          skills: [],
          summary: `분석 실패: ${fileErr.message}`
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
  console.log(`  보안 안심형 다중 비교 매트릭스 서버가 가동되었습니다.`);
  console.log(`  주소: http://localhost:${port}`);
  console.log(`=======================================================`);
});