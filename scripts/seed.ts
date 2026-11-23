import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { TaskType } from '@google/generative-ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const embeddings = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  model: 'gemini-embedding-001',
  taskType: TaskType.RETRIEVAL_DOCUMENT,
});

// 사내 규정 샘플 문서 데이터 (실제 서비스 시 PDF 파싱 결과로 대체 가능)
const companyPolicies = [
  {
    category: '휴가 및 근태 규정',
    title: '제1조 (연차 유급휴가 사용 및 신청 기준)',
    content:
      '임직원의 연차 유급휴가는 1일 단위, 오전 반차(09:00~13:00, 0.5일), 오후 반차(14:00~18:00, 0.5일) 단위로 사용할 수 있다. 연차 및 반차는 원칙적으로 사용 전일 업무 종료 전까지 사내 시스템을 통해 신청해야 하며, 긴급한 사유에 한해 당일 오전 9시 이전까지 부서장 승인 후 신청할 수 있다.',
  },
  {
    category: '휴가 및 근태 규정',
    title: '제2조 (경조사 유급휴가 기준)',
    content:
      '본인 결혼 시 5일, 자녀 결혼 시 1일, 배우자 출산 시 10일의 유급 경조휴가를 부여한다. 부모 및 배우자 사망 시 5일, 조부모·외조부모 및 형제자매 사망 시 3일의 유급휴가를 부여하며, 휴가 종료 후 1주일 이내에 청첩장 또는 가족관계증명서·사망진단서 등 증빙서류를 총무팀에 제출해야 한다.',
  },
  {
    category: '경비 및 복리후생 규정',
    title: '제3조 (야근 식대 및 교통비 지원)',
    content:
      '평일 오후 8시 이후까지 연장 근무를 수행한 임직원에게는 1인당 최대 15,000원 한도 내에서 저녁 식대를 법인카드로 지원한다. 또한 오후 10시 이후 퇴근 시에는 자택까지의 택시비를 실비 지원하며, 영수증 첨부 후 익월 5일까지 경비 정산 시스템을 통해 청구한다.',
  },
  {
    category: '경비 및 복리후생 규정',
    title: '제4조 (자기계발비 및 도서 구입 지원)',
    content:
      '수습 기간(3개월)을 종료한 정규직 임직원에게는 연간 120만 원 한도 내에서 직무 관련 도서 구입, 온라인 강의 수강, 컨퍼런스 참가비를 지원한다. 도서 구입 시 총무팀에 구매 링크를 요청하면 법인 계정으로 일괄 구매하여 지급한다.',
  },
  {
    category: 'IT 및 보안 지침',
    title: '제5조 (사내 장비 반출 및 VPN 접속 보안)',
    content:
      '지급된 업무용 노트북의 사외 반출은 재택근무 및 출장 시에만 허용되며, 카페 등 공공장소에서 업무 시 반드시 사내 전용 VPN(WireGuard)을 연결해야 한다. 외부 저장매체(USB) 연결은 원칙적으로 차단되며, 부득이한 경우 정보보안팀에 사유서를 제출해 24시간 임시 승인을 받아야 한다.',
  },
];

async function seed() {
  console.log('사내 규정 문서 임베딩 및 Supabase 적재 시작...');

  // 기존 데이터 초기화 (재실행 시 중복 방지)
  await supabase.from('company_documents').delete().neq('id', 0);

  for (const doc of companyPolicies) {
    const fullText = `[${doc.category}] ${doc.title}\n${doc.content}`;
    
    // 768차원 벡터 생성 (Supabase table의 vector(768) 스키마와 일치)
    const vector = await embeddings.embedQuery(fullText);
    const slicedVector = vector.slice(0, 768);

    const { error } = await supabase.from('company_documents').insert({
      content: fullText,
      metadata: {
        category: doc.category,
        title: doc.title,
      },
      embedding: slicedVector,
    });

    if (error) {
      console.error(`적재 실패 (${doc.title}):`, error.message);
    } else {
      console.log(`적재 완료: ${doc.title}`);
    }
  }

  console.log('모든 사내 규정 데이터 적재가 완료되었습니다!');
}

seed();