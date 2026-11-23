import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    const [empRes, reqRes, docRes] = await Promise.all([
      supabase.from('employees').select('*').eq('id', 'emp_001').single(),
      supabase
        .from('leave_requests')
        .select('*')
        .eq('employee_id', 'emp_001')
        .order('created_at', { ascending: false })
        .limit(10),
      supabase.from('company_documents').select('id, metadata').order('id', { ascending: true }),
    ]);

    return NextResponse.json({
      employee: empRes.data ?? null,
      leaveRequests: reqRes.data ?? [],
      documents: docRes.data ?? [],
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'DB 상태 조회 실패' },
      { status: 500 }
    );
  }
}

// 시연 반복용 데모 데이터 초기화 (잔여 연차 12.5일 복구 및 신청 내역 삭제)
export async function POST() {
  try {
    await supabase.from('leave_requests').delete().eq('employee_id', 'emp_001');
    await supabase
      .from('employees')
      .update({ remaining_leave: 12.5 })
      .eq('id', 'emp_001');

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || '초기화 실패' },
      { status: 500 }
    );
  }
}