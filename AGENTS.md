# AGENTS.md

aitest là nền tảng cho AI agent tự đọc test plan, tự thực thi các bước qua MCP và xuất báo cáo. Nền tảng dựng trên `@deepseek-ai/cordis` theo kiến trúc "mọi thứ là plugin" của DeepSeek Harness (dsh). Đọc [docs/architecture.md](docs/architecture.md) trước khi sửa `packages/`. Hướng dẫn cho người dùng cuối nằm ở [docs/user-guide.md](docs/user-guide.md).

## Mô hình hoạt động

aitest không chạy agent loop. aitest vừa là **ACP client** điều khiển agent bên ngoài (mặc định `kiro-cli acp`), vừa là **MCP host** cung cấp công cụ cho agent.

1. Runner nạp plan, chạy fixture `setup` một cách xác định.
2. Runner mở một endpoint MCP riêng cho case (`ctx.gateway.expose`) rồi truyền endpoint vào `session/new` của ACP.
3. Agent gọi tool qua endpoint; gateway chuyển mọi lời gọi vào `ctx.actions.invoke`, đi qua pipeline `action/before` → `execute` → `action/after`.
4. Agent gọi `assert_expectation`; plugin `verdict` tự đọc giá trị thật trong evidence và so sánh.
5. Runner chạy `teardown`, tính verdict, ghi `case/end`; cuối lượt chạy dựng `RunReport` từ run log và phát `run/report`.

## Sơ đồ thư mục

```
packages/            @aitest/<tên> — mỗi package là một hoặc nhiều plugin cordis
  core/              kiểu miền, danh mục event, service lõi, kernel nạp plugin từ YAML, bộ so khớp
  plan-yaml/         định dạng *.plan.yaml
  mcp-gateway/       MCP server Streamable HTTP trong process, mỗi case một endpoint
  agent-acp/         driver ACP (Kiro mặc định)
  runner/            điều phối lượt chạy, fixture, prompt mặc định
  verdict/           evidence, assert_expectation, note_step, tính verdict
  action-http/       http_request
  action-sqlite/     <namespace>_query cho SQLite
  action-mcp-proxy/  nối MCP server ngoài (Postgres, Playwright...) thành action
  action-wait/       wait_until cho xử lý bất đồng bộ
  action-webhook/    webhook_create, webhook_wait để nhận callback
  guard-basic/       chặn SQL ghi, giới hạn host, chặn action theo tên
  reporters/         console, markdown, junit (mỗi subpath là một plugin)
  cli/               lệnh aitest
examples/
  order-api/         ứng dụng mẫu: API, giao diện web, SQLite, lỗi cố ý ở kiểm tra lô chẵn
  plans/             plan mẫu: API, integration, E2E giao diện
  plugins/           plugin mẫu nạp theo đường dẫn tương đối
docs/                architecture.md, user-guide.md, plan.schema.json
aitest.yml           cấu hình plugin mặc định
aitest.e2e.yml       kế thừa aitest.yml, thêm Playwright MCP
.aitest/             đầu ra lượt chạy (bị git bỏ qua)
```

## Lệnh

```sh
pnpm install                 # pnpm 11, node >=22.18
pnpm run typecheck           # tsc --noEmit trên toàn workspace
pnpm test                    # vitest; agent kịch bản, không gọi LLM; khoảng 10 s
AITEST_SKIP_BROWSER=1 pnpm test   # bỏ qua bài test trình duyệt khi máy không có Chrome
pnpm demo:api                # Order API mẫu ở cổng 4100
pnpm aitest validate <plan>
pnpm aitest run <plan> [--case A,B] [--agent kiro]          # gọi Kiro thật, tốn lượt dùng
pnpm aitest -c aitest.e2e.yml run examples/plans/order-ui.plan.yaml
pnpm aitest report .aitest/runs/<id>/events.jsonl           # dựng lại báo cáo từ log
```

Chạy `typecheck` và `test` trước khi kết thúc mọi thay đổi code. Chỉ chạy với Kiro thật khi thay đổi ảnh hưởng tới nội dung agent nhìn thấy: prompt, mô tả tool, định dạng kết quả tool. Báo cáo lại kết quả đã chạy, kể cả khi thất bại.

## Bất biến kiến trúc

- **LLM không quyết định pass/fail.** Verdict chỉ được tính từ assertion do plugin `verdict` đánh giá trên evidence thật. Không thêm đường nào cho agent tự báo giá trị thực tế hoặc tự kết luận.
- **Tiêu chí của plan là cố định.** Khi expectation có `check`, `op` và giá trị mong đợi luôn lấy từ plan; tham số của agent bị bỏ qua.
- **Run log là nguồn sự thật.** Mọi thông tin xuất hiện trong báo cáo phải dựng lại được từ `events.jsonl` qua `deriveReport`. Thông tin mới trong báo cáo đòi hỏi một loại event mới, ghi qua `scope.log`.
- **Mọi thao tác của agent đi qua gateway.** Không cấp cho agent MCP server nào khác ngoài endpoint của gateway. Tích hợp MCP server ngoài phải qua `action-mcp-proxy` để giữ guard, evidence và log.
- **Thực thi quyết định tại nơi thực thi.** Giới hạn `requires` và guard được kiểm tra trong `ActionRegistry.invoke`, không chỉ ở danh sách tool hay prompt. Kiểm thử từ chối phải gọi qua `invoke`.
- **Fixture không qua AI.** `setup`/`teardown` do runner chạy; lỗi setup cho verdict `error` và không gọi agent; teardown luôn chạy.
- **Tính năng mới đi qua plugin.** Thêm hành vi bằng service, event hoặc action mới; chỉ sửa runner khi điểm mở rộng hiện có không đủ, và cập nhật docs/architecture.md cùng lúc.

## Quy ước

- **Ngôn ngữ:** code, định danh, log message, tên metric dùng tiếng Anh. Văn xuôi dùng tiếng Việt kỹ thuật theo `~/.kiro/steering/language-policy-vi.md`, gồm tài liệu, comment, JSDoc, mô tả tool, prompt và commit message.
- **ESM và TypeScript:** `"type": "module"`; import cục bộ dùng đuôi `.ts`; import giữa package dùng tên package. Mã chạy trực tiếp bằng `tsx`, không có bước build.
- **Đăng ký là effect:** mọi `register`/`section`/`registerFormat` bọc trong `ctx.effect()` và tự gỡ khi plugin unload. Listener đăng ký qua `ctx.on()`.
- **Waterfall phải gọi `next()`** khi listener không giữ quyết định. Listener `action/after` trả outcome mới bằng cách spread outcome cũ.
- **Event khai báo bằng declaration merging** trên `@deepseek-ai/cordis` `Events`, kèm JSDoc ghi `@mode`. Danh mục event nằm ở `packages/core/src/events.ts` và mục 3.2 của tài liệu kiến trúc.
- **Service mới** khai báo `Context` qua `declare module '@deepseek-ai/cordis'`; package dùng service của package khác khai báo phụ thuộc kiểu bằng `import type {} from '<package>'`.
- **Tên action** khớp `^[a-z][a-z0-9_]{0,63}$`, có dạng `<namespace>_<động từ>`. Action không sinh dữ liệu cần đối chiếu đặt `evidence: false`.
- **Kết quả action** là JSON thuần, đủ để assert theo path. Giới hạn kích thước tại nơi biết kết quả hoàn chỉnh (gateway có `maxResultChars`).
- **Bí mật** đọc qua `${env.NAME}` trong cấu hình; không commit giá trị thật.

## Kiểm thử

- Bài test nằm ở `packages/<tên>/tests/`. Test tích hợp dùng `setupHarness` trong `packages/runner/tests/support.ts`: dựng kernel từ `aitest.yml` thật, khởi chạy Order API với DB tạm và đăng ký agent kịch bản gọi tool qua MCP client thật.
- Plugin mới có test chạy qua cấu hình thật, không chỉ `ctx.plugin(...)` dựng tay.
- Registry mới có test chứng minh gỡ plugin thì đóng góp biến mất.
- Các file test chạy song song. Mỗi file dùng cổng riêng (4199, 4198, 4197...) và thư mục tạm riêng, dọn trong `afterAll`.
- Thay đổi nội dung agent nhìn thấy cần thêm một lần chạy Kiro thật; ghi số liệu vào mục kết quả kiểm chứng của tài liệu kiến trúc khi số liệu thay đổi.

## Tài liệu

Tài liệu đi cùng thay đổi code trong cùng commit: README, tài liệu kiến trúc, hướng dẫn sử dụng, JSON Schema của plan và JSDoc liên quan. Mỗi sự thật chỉ có một nơi ghi chính; nơi khác liên kết tới.

## Commit

Chỉ commit khi người dùng yêu cầu. Commit message viết tiếng Việt theo chính sách ngôn ngữ, dòng đầu dưới 72 ký tự, mô tả thay đổi và lý do.

## Sửa file hướng dẫn này

`CLAUDE.md` là symlink tới `AGENTS.md` ở thư mục gốc và ở `packages/`; sửa file thật. Quy tắc riêng cho package nằm ở [packages/AGENTS.md](packages/AGENTS.md). Mỗi quy tắc phải đúng với code hiện tại; khi code đổi, cập nhật quy tắc trong cùng commit.
