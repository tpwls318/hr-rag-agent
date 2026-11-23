'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface InterruptPayload {
  type: string;
  employeeId: string;
  leaveDate: string;
  leaveType: string;
  deductDays: number;
  reason: string;
  message: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  usedTools?: string[];
  interrupt?: InterruptPayload | null;
  resolved?: 'approved' | 'rejected';
}

interface EmployeeData {
  id: string;
  name: string;
  department: string;
  remaining_leave: number;
}

interface LeaveRequestItem {
  id: number;
  leave_date: string;
  leave_type: string;
  reason: string;
  status: string;
  created_at: string;
}

interface PolicyDocItem {
  id: number;
  metadata: {
    category?: string;
    title?: string;
  };
}

const TOOL_LABELS: Record<string, string> = {
  search_company_policy: '📄 사내 규정 RAG 검색',
  get_leave_status: '📊 근태/잔여 연차 DB 조회',
  request_leave: '⚡ 연차 신청 Action 실행',
};

const SAMPLE_PROMPTS = [
  '경조사 휴가 기준이랑 증빙서류 제출 기한 알려줘',
  '내 남은 연차랑 최근 신청 내역 확인해 줘',
  '내일(2026-11-24) 개인 사유로 오후반차 신청해 줘',
  '평일 밤 9시까지 야근하면 식대랑 택시비 지원돼?',
];

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        '안녕하세요, 박세진님! 사내 총무·근태·IT 규정 AI 오퍼레이터입니다.\n사내 규정 검색부터 잔여 연차 조회, 연차/반차 신청까지 무엇이든 말씀해 주세요.',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [threadId, setThreadId] = useState('');

  useEffect(() => {
    setThreadId(`thread-${Date.now()}`);
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 실시간 DB 상태 state
  const [employee, setEmployee] = useState<EmployeeData | null>(null);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestItem[]>([]);
  const [documents, setDocuments] = useState<PolicyDocItem[]>([]);
  const [dbUpdating, setDbUpdating] = useState(false);

  const fetchDbStatus = useCallback(async () => {
    setDbUpdating(true);
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setEmployee(data.employee);
        setLeaveRequests(data.leaveRequests);
        setDocuments(data.documents);
      }
    } finally {
      setTimeout(() => setDbUpdating(false), 300);
    }
  }, []);

  useEffect(() => {
    fetchDbStatus();
  }, [fetchDbStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleResetDemo = async () => {
    if (loading) return;
    setDbUpdating(true);
    await fetch('/api/status', { method: 'POST' });
    await fetchDbStatus();
    setThreadId(`thread-${Date.now()}`);
    setMessages([
      {
        id: `reset-${Date.now()}`,
        role: 'assistant',
        content: '데모 데이터가 초기화되었습니다. (잔여 연차 12.5일 복구 완료)',
      },
    ]);
  };

  const sendMessage = async (textToSend?: string) => {
    const query = (textToSend ?? input).trim();
    if (!query || loading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: query,
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: query, threadId }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        role: 'assistant',
        content: data.interrupt
          ? '연차 신청을 진행하기 전에 최종 확인이 필요합니다.'
          : data.reply,
        usedTools: data.usedTools,
        interrupt: data.interrupt,
      };

      setMessages((prev) => [...prev, botMsg]);
      await fetchDbStatus();
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `오류가 발생했습니다: ${err.message}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleApproval = async (msgId: string, approved: boolean) => {
    if (loading) return;
    setLoading(true);

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, resolved: approved ? 'approved' : 'rejected' } : m
      )
    );

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, resumeApproval: approved }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setMessages((prev) => [
        ...prev,
        {
          id: `bot-resume-${Date.now()}`,
          role: 'assistant',
          content: data.reply,
          usedTools: data.usedTools,
        },
      ]);

      // 승인 직후 우측 실시간 DB 패널 즉시 동기화
      await fetchDbStatus();
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `승인 처리 중 오류가 발생했습니다: ${err.message}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col items-center py-6 px-4">
      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-5 h-[88vh]">
        {/* 좌측: AI 에이전트 채팅 영역 (8컬럼) */}
        <div className="lg:col-span-8 bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full overflow-hidden">
          <header className="px-6 py-4 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
            <div>
              <h1 className="text-base sm:text-lg font-bold tracking-tight">
                사내 지식 RAG + 근태 액션 AI 에이전트
              </h1>
              <p className="text-xs text-slate-300 mt-0.5">
                LangGraph · Gemini 3.8 Flash · Supabase pgvector · Human-in-the-Loop
              </p>
            </div>
            <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-1 rounded-full font-medium shrink-0">
              {employee ? `${employee.name} (${employee.id})` : 'emp_001'}
            </span>
          </header>

          {/* 샘플 질문 바 */}
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex gap-2 overflow-x-auto">
            {SAMPLE_PROMPTS.map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => sendMessage(prompt)}
                disabled={loading}
                className="shrink-0 text-xs bg-white hover:bg-blue-50 text-slate-700 hover:text-blue-700 border border-slate-300 rounded-full px-3 py-1.5 transition cursor-pointer disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* 채팅 메시지 영역 */}
          <main className="flex-1 overflow-y-auto p-5 space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                {msg.role === 'assistant' && msg.usedTools && msg.usedTools.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {msg.usedTools.map((toolName) => (
                      <span
                        key={toolName}
                        className="text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-md"
                      >
                        {TOOL_LABELS[toolName] || toolName}
                      </span>
                    ))}
                  </div>
                )}

                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-sm whitespace-pre-wrap'
                      : 'bg-slate-100 text-slate-800 rounded-bl-sm border border-slate-200'
                  }`}
                >
                  {msg.role === 'user' ? (
                    msg.content
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h3: ({ ...props }) => (
                          <h3 className="text-sm font-bold text-slate-900 mt-2.5 mb-1" {...props} />
                        ),
                        p: ({ ...props }) => <p className="mb-1.5 last:mb-0" {...props} />,
                        ul: ({ ...props }) => (
                          <ul className="list-disc pl-4 space-y-0.5 my-1" {...props} />
                        ),
                        li: ({ ...props }) => <li className="text-slate-700" {...props} />,
                        strong: ({ ...props }) => (
                          <strong className="font-semibold text-slate-900" {...props} />
                        ),
                        code: ({ ...props }) => (
                          <code
                            className="bg-slate-200/80 text-indigo-700 px-1.5 py-0.5 rounded text-xs font-mono"
                            {...props}
                          />
                        ),
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  )}

                  {msg.interrupt && (
                    <div className="mt-3 p-3.5 bg-white rounded-xl border border-amber-300 shadow-xs text-slate-800">
                      <div className="flex items-center gap-1.5 text-amber-700 font-semibold text-xs mb-2">
                        <span>⚠️ Human-in-the-Loop 실행 승인 요청</span>
                      </div>
                      <div className="text-xs space-y-1 text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                        <div>• <strong>신청 일자:</strong> {msg.interrupt.leaveDate}</div>
                        <div>• <strong>휴가 종류:</strong> {msg.interrupt.leaveType} ({msg.interrupt.deductDays}일 차감)</div>
                        <div>• <strong>신청 사유:</strong> {msg.interrupt.reason}</div>
                      </div>

                      {!msg.resolved ? (
                        <div className="flex gap-2 mt-3">
                          <button
                            onClick={() => handleApproval(msg.id, true)}
                            disabled={loading}
                            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-2 rounded-lg transition cursor-pointer disabled:opacity-50"
                          >
                            승인 및 DB 반영
                          </button>
                          <button
                            onClick={() => handleApproval(msg.id, false)}
                            disabled={loading}
                            className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-semibold py-2 rounded-lg transition cursor-pointer disabled:opacity-50"
                          >
                            취소
                          </button>
                        </div>
                      ) : (
                        <div className="mt-2.5 text-xs font-semibold text-right">
                          {msg.resolved === 'approved' ? (
                            <span className="text-emerald-600">✓ 승인 완료됨 (DB 반영됨)</span>
                          ) : (
                            <span className="text-rose-600">✕ 사용자 취소됨</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" />
                <span>에이전트가 규정을 검색하고 실행 경로를 판단하고 있습니다...</span>
              </div>
            )}
            <div ref={bottomRef} />
          </main>

          {/* 입력창 */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
            className="p-4 border-t border-slate-200 bg-white flex gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="예: 내일 오후반차 신청해 줘 / 경조사 휴가 기준 알려줘"
              className="flex-1 text-sm border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition cursor-pointer disabled:opacity-50"
            >
              전송
            </button>
          </form>
        </div>

        {/* 우측: 실시간 Supabase DB 상태 모니터 (4컬럼) */}
        <aside className="lg:col-span-4 bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  dbUpdating ? 'bg-amber-400 animate-ping' : 'bg-emerald-500'
                }`}
              />
              <h2 className="text-sm font-bold text-slate-800">실시간 Supabase DB 상태</h2>
            </div>
            <button
              onClick={handleResetDemo}
              disabled={loading}
              className="text-[11px] font-medium text-slate-600 hover:text-rose-600 bg-white hover:bg-rose-50 border border-slate-300 px-2.5 py-1 rounded-lg transition cursor-pointer disabled:opacity-50"
            >
              데모 초기화
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* 1. 직원 잔여 연차 카드 */}
            <section>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                employees 테이블 (Live)
              </div>
              <div
                className={`p-4 rounded-xl border transition-all duration-300 ${
                  dbUpdating
                    ? 'bg-blue-50 border-blue-300 scale-[1.01]'
                    : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-slate-900">
                      {employee?.name ?? '박세진'}
                    </div>
                    <div className="text-xs text-slate-500">
                      {employee?.department ?? '프로덕트개발팀'} · {employee?.id ?? 'emp_001'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] text-slate-500">잔여 연차</div>
                    <div className="text-2xl font-extrabold text-blue-600">
                      {employee ? `${Number(employee.remaining_leave)}일` : '-'}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* 2. 최근 연차 신청 로그 */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  leave_requests 테이블 ({leaveRequests.length}건)
                </span>
              </div>
              {leaveRequests.length === 0 ? (
                <div className="text-xs text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-center">
                  아직 승인된 연차 신청 내역이 없습니다.
                </div>
              ) : (
                <div className="space-y-2">
                  {leaveRequests.map((req) => (
                    <div
                      key={req.id}
                      className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs flex items-center justify-between"
                    >
                      <div>
                        <div className="font-semibold text-slate-800">
                          {req.leave_date} · {req.leave_type}
                        </div>
                        <div className="text-slate-500 mt-0.5">{req.reason}</div>
                      </div>
                      <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                        {req.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 3. pgvector 인덱싱 문서 목록 */}
            <section>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                company_documents (pgvector {documents.length}건)
              </div>
              <div className="space-y-1.5">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="px-3 py-2 rounded-lg bg-indigo-50/60 border border-indigo-100 text-xs text-slate-700"
                  >
                    <span className="text-[10px] font-semibold text-indigo-600 block">
                      {doc.metadata?.category}
                    </span>
                    <span className="font-medium">{doc.metadata?.title}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}