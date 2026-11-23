import { NextRequest, NextResponse } from 'next/server';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { hrAgentGraph } from '@/lib/agent';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, threadId = 'demo-thread-1', resumeApproval } = body;

    const config = {
      configurable: { thread_id: threadId },
    };

    let result;

    // 1. Human-in-the-loop 승인/거절 응답으로 재개하는 경우
    if (typeof resumeApproval === 'boolean') {
      result = await hrAgentGraph.invoke(
        new Command({ resume: { approved: resumeApproval } }),
        config
      );
    } else {
      // 2. 일반 사용자 메시지 입력 실행
      result = await hrAgentGraph.invoke(
        { messages: [new HumanMessage(message)] },
        config
      );
    }

    // 현재 그래프 상태 확인 (interrupt 대기 중인지 체크)
    const state = await hrAgentGraph.getState(config);
    const pendingInterrupt = state.tasks?.[0]?.interrupts?.[0]?.value ?? null;

    // 이번 턴에서 호출된 도구 목록 추출 (UI 시각화용)
    const usedTools: string[] = [];
    for (const msg of result.messages) {
      if (msg._getType() === 'ai') {
        const aiMsg = msg as AIMessage;
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          for (const tc of aiMsg.tool_calls) {
            if (!usedTools.includes(tc.name)) {
              usedTools.push(tc.name);
            }
          }
        }
      }
    }

    // 마지막 AI 텍스트 응답 추출
    const lastMessage = result.messages[result.messages.length - 1];
    const replyText =
      typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : Array.isArray(lastMessage?.content)
        ? lastMessage.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
        : '';

    return NextResponse.json({
      reply: replyText,
      usedTools,
      interrupt: pendingInterrupt,
    });
  } catch (error: any) {
    console.error('Agent API Error:', error);
    return NextResponse.json(
      { error: error.message || '에이전트 실행 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}