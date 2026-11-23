import { createClient } from '@supabase/supabase-js';
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { TaskType } from '@google/generative-ai';
import { tool } from '@langchain/core/tools';
import { SystemMessage } from '@langchain/core/messages';
import { StateGraph, MessagesAnnotation, MemorySaver, interrupt } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const embeddings = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  model: 'gemini-embedding-001',
  taskType: TaskType.RETRIEVAL_QUERY,
});

// 1. [RAG 도구] 사내 규정 벡터 검색
const searchCompanyPolicy = tool(
  async ({ query }) => {
    const rawVector = await embeddings.embedQuery(query);
    const queryEmbedding = rawVector.slice(0, 768);

    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.45,
      match_count: 3,
    });

    if (error) return `규정 검색 중 오류가 발생했습니다: ${error.message}`;
    if (!data || data.length === 0) return '관련된 사내 규정을 찾지 못했습니다.';

    return data
      .map((doc: any) => `[유사도 ${(doc.similarity * 100).toFixed(1)}%] ${doc.content}`)
      .join('\n\n---\n\n');
  },
  {
    name: 'search_company_policy',
    description: '연차, 경조사 휴가, 야근 식대/택시비, 자기계발비, 노트북/VPN 보안 등 사내 규정을 검색합니다.',
    schema: z.object({
      query: z.string().describe('검색할 사내 규정 키워드 또는 질문'),
    }),
  }
);

// 2. [조회 도구] 잔여 연차 및 신청 내역 조회
const getLeaveStatus = tool(
  async ({ employeeId }) => {
    const { data: emp, error: empError } = await supabase
      .from('employees')
      .select('*')
      .eq('id', employeeId)
      .single();

    if (empError || !emp) return '직원 정보를 찾을 수 없습니다.';

    const { data: requests } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(5);

    const history =
      requests && requests.length > 0
        ? requests
            .map((r: any) => `- ${r.leave_date} (${r.leave_type}) : ${r.reason || '사유 없음'} [${r.status}]`)
            .join('\n')
        : '최근 신청 내역이 없습니다.';

    return `직원명: ${emp.name} (${emp.department})\n잔여 연차: ${emp.remaining_leave}일\n\n[최근 연차 신청 내역]\n${history}`;
  },
  {
    name: 'get_leave_status',
    description: '직원의 현재 잔여 연차 일수와 최근 휴가 신청 내역을 조회합니다.',
    schema: z.object({
      employeeId: z.string().default('emp_001').describe('직원 ID (기본값: emp_001)'),
    }),
  }
);

// 3. [액션 도구 + Human-in-the-loop] 연차/반차 신청 (DB Write 전 승인 대기)
const requestLeave = tool(
  async ({ employeeId, leaveDate, leaveType, reason }) => {
    const deductDays = leaveType === '연차' ? 1.0 : 0.5;

    // Human-in-the-loop: 실제 DB 수정 직전 그래프 실행을 일시 정지하고 승인 요청
    const approval = interrupt({
      type: 'LEAVE_APPROVAL',
      employeeId,
      leaveDate,
      leaveType,
      deductDays,
      reason,
      message: `${leaveDate}일자 '${leaveType}' (${deductDays}일 차감) 신청을 승인하시겠습니까?`,
    });

    if (approval !== true && approval?.approved !== true) {
      return '사용자가 연차 신청을 취소했습니다. 데이터베이스는 변경되지 않았습니다.';
    }

    // 승인 완료 시 실제 DB 업데이트 실행
    const { data: emp } = await supabase
      .from('employees')
      .select('remaining_leave')
      .eq('id', employeeId)
      .single();

    if (!emp || Number(emp.remaining_leave) < deductDays) {
      return '잔여 연차가 부족하여 신청을 완료할 수 없습니다.';
    }

    const { error: insertError } = await supabase.from('leave_requests').insert({
      employee_id: employeeId,
      leave_date: leaveDate,
      leave_type: leaveType,
      reason,
      status: 'APPROVED',
    });

    if (insertError) return `연차 신청 저장 실패: ${insertError.message}`;

    const updatedLeave = Number(emp.remaining_leave) - deductDays;
    await supabase
      .from('employees')
      .update({ remaining_leave: updatedLeave })
      .eq('id', employeeId);

    return `연차 신청이 최종 승인되어 DB에 반영되었습니다. (${leaveDate} / ${leaveType}, 잔여 연차: ${updatedLeave}일)`;
  },
  {
    name: 'request_leave',
    description: '직원의 연차, 오전반차, 오후반차를 실제로 신청합니다. 실행 전 반드시 사용자 승인을 거칩니다.',
    schema: z.object({
      employeeId: z.string().default('emp_001'),
      leaveDate: z.string().describe('휴가 날짜 (YYYY-MM-DD 형식)'),
      leaveType: z.enum(['연차', '오전반차', '오후반차']).describe('휴가 종류'),
      reason: z.string().default('개인 사유').describe('휴가 신청 사유'),
    }),
  }
);

const tools = [searchCompanyPolicy, getLeaveStatus, requestLeave];
const toolNode = new ToolNode(tools);

const llm = new ChatGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  model: 'gemini-3.5-flash',
  temperature: 0.1,
}).bindTools(tools);

// 에이전트 판단 노드 (Router & Reasoner)
async function agentNode(state: typeof MessagesAnnotation.State) {
  const systemPrompt = new SystemMessage(
    `당신은 사내 총무·근태·IT 규정 전문 AI 오퍼레이터입니다.
현재 접속한 직원 정보: 이름 '박세진', 부서 '프로덕트개발팀', 사번 'emp_001'.
오늘 날짜: 2026-11-23 (월요일).

업무 처리 원칙:
1. 사내 규정(휴가 기준, 경조사, 식대/교통비, 자기계발비, 보안/VPN) 질문에는 반드시 'search_company_policy' 도구를 먼저 호출해 근거 조항을 확인한 뒤 답변하세요.
2. 잔여 연차나 신청 내역 질문에는 'get_leave_status' 도구를 호출하세요.
3. 사용자가 연차 또는 반차 신청을 요청하면 먼저 규정 위반 여부(예: 당일 신청 제한 등)를 확인하고, 문제가 없다면 'request_leave' 도구를 호출하세요.
4. 추측하지 말고 항상 도구의 조회 결과를 바탕으로 간결하고 명확하게 답변하세요.`
  );

  const response = await llm.invoke([systemPrompt, ...state.messages]);
  return { messages: [response] };
}

// 조건부 엣지: 도구 호출이 필요하면 tools 노드로, 답변이 완성되면 종료
function shouldContinue(state: typeof MessagesAnnotation.State) {
  const lastMessage = state.messages[state.messages.length - 1];
  if ('tool_calls' in lastMessage && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
    return 'tools';
  }
  return '__end__';
}

// StateGraph 조립 및 Checkpointer(상태 저장소) 연결
const checkpointer = new MemorySaver();

export const hrAgentGraph = new StateGraph(MessagesAnnotation)
  .addNode('agent', agentNode)
  .addNode('tools', toolNode)
  .addEdge('__start__', 'agent')
  .addConditionalEdges('agent', shouldContinue, {
    tools: 'tools',
    __end__: '__end__',
  })
  .addEdge('tools', 'agent')
  .compile({ checkpointer });