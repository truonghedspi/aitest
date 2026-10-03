import type {
  ActionCall, ActionDecision, ActionOutcome, AgentUpdate, CaseScope, RunContext, RunEvent, RunReport, VerdictDecision,
} from './types.ts'

/**
 * Danh mục event là các điểm mở rộng của nền tảng.
 *
 * Quy ước dispatch theo cordis:
 * - waterfall: listener nhận `next` ở tham số cuối; listener không quyết định thì phải `return next()`.
 * - emit: chỉ quan sát, không thay đổi kết quả.
 * - parallel: quan sát bất đồng bộ, runner chờ mọi listener hoàn tất.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Trước khi chạy action. Dùng cho guard: cho phép, từ chối hoặc sửa `call.args`. @mode waterfall */
    'action/before'(call: ActionCall, next: () => Promise<ActionDecision>): Promise<ActionDecision>
    /** Sau khi chạy action. Dùng để bổ sung annotation, ví dụ `evidenceId`. @mode waterfall */
    'action/after'(call: ActionCall, outcome: ActionOutcome, next: () => Promise<ActionOutcome>): Promise<ActionOutcome>
    /** Kết quả cuối cùng của action, sau mọi waterfall. @mode emit */
    'action/result'(call: ActionCall, outcome: ActionOutcome): void

    /** Mỗi bản ghi mới trong run log. @mode emit */
    'run/event'(event: RunEvent): void
    /** Bắt đầu lượt chạy, trước bước chuẩn bị: plugin cung cấp biến dùng chung vào `run.vars` (ví dụ catalog hệ thống). @mode parallel */
    'run/start'(run: RunContext): Promise<void>
    /** Chuẩn bị lượt chạy trước mọi case, sau `run/start`: phân giải đầu vào, chuẩn bị dữ liệu dùng chung. @mode parallel */
    'run/prepare'(run: RunContext): Promise<void>
    /** Bắt đầu một case, trước khi mở session agent. @mode parallel */
    'case/start'(scope: CaseScope): Promise<void>
    /**
     * Sau fixture `setup`, trước agent: plugin chạy các bước đầu case thực thi được không qua agent (bước `call:`),
     * trả số bước đã hoàn tất tính từ bước 1. Ném lỗi khi một bước thất bại; case nhận verdict `error`. @mode waterfall
     */
    'case/steps'(scope: CaseScope, next: () => Promise<number>): Promise<number>
    /**
     * Một bước do nền tảng chạy (pha `step`) đã xong và lời gọi đã ghi `action/call`; `step` đánh số từ 1.
     * Plugin `verdict` đối chiếu expectation có `from` trỏ tới bước này. @mode parallel
     */
    'case/step-done'(scope: CaseScope, step: number, outcome: ActionOutcome): Promise<void>
    /** Cập nhật thô từ agent (tin nhắn, tool call). @mode emit */
    'case/agent-update'(scope: CaseScope, update: AgentUpdate): void
    /** Tính verdict cho case. Plugin verdict quyết định; mặc định giữ `base`. @mode waterfall */
    'case/verdict'(scope: CaseScope, base: VerdictDecision, next: () => Promise<VerdictDecision>): Promise<VerdictDecision>
    /** Case kết thúc. @mode parallel */
    'case/end'(scope: CaseScope, decision: VerdictDecision): Promise<void>
    /** Run kết thúc, báo cáo đã dựng xong từ run log. Reporter lắng nghe event này. @mode parallel */
    'run/report'(report: RunReport): Promise<void>
  }
}

export {}
