# Kiến trúc aitest

Tài liệu mô tả thiết kế bản khả thi (PoC) của aitest. aitest là nền tảng cho AI agent tự đọc test plan, tự thực thi các bước qua MCP và xuất báo cáo.

## 1. Mục tiêu và phạm vi

| Yêu cầu | Cách đáp ứng |
|---|---|
| Soạn test plan | File `*.plan.yaml` có JSON Schema cho IDE; lệnh `aitest validate` kiểm tra trước khi chạy |
| Bổ sung, sửa action | Mỗi action là một plugin; MCP server bên ngoài nối vào qua plugin `action-mcp-proxy` |
| Mọi thao tác đi qua MCP | Agent chỉ thấy một MCP gateway; mọi lời gọi tool đi qua gateway |
| Mọi thứ là plugin | Kể cả service lõi (`actions`, `plans`, `runlog`...) cũng là plugin thay thế được qua `aitest.yml` |
| Agent qua ACP | Driver `agent-acp` nói Agent Client Protocol; mặc định dùng Kiro (`kiro-cli acp`) |

| Test integration nhiều service | Fixture `setup`/`teardown`, action `wait_until` cho xử lý bất đồng bộ, webhook sink nhận callback |
| Test E2E qua giao diện web | Playwright MCP nối qua `action-mcp-proxy`; agent đối chiếu chéo giao diện với cơ sở dữ liệu |
| Soạn plan cùng AI qua giao diện chat | Giao diện web theo mô hình của dsh; agent dùng tool soạn plan qua MCP gateway |

Ngoài phạm vi PoC: chạy song song nhiều case, đăng nhập và phân quyền người dùng trên giao diện web.

## 2. Quyết định nền tảng

### 2.1. Tự dựng trên cordis, học theo dsh

Nền tảng dùng `@deepseek-ai/cordis` 4.0.4. Đây là bản cordis mà DeepSeek Harness (dsh) vendor, vá lỗi vòng đời và phát hành trên npm. Bản upstream `cordis` vẫn ở mức `4.0.0-rc`.

Các mẫu thiết kế học từ dsh:

| Mẫu của dsh | Áp dụng trong aitest |
|---|---|
| Plugin đóng góp service, event và effect có thể đảo ngược | Mọi đăng ký (`actions.register`, `prompt.section`...) là effect, tự gỡ khi plugin unload |
| Pipeline tool `pre-execute` / `post-execute` / `result` dạng waterfall | Pipeline action `action/before` / `action/after` / `action/result` |
| Session log append-only là nguồn sự thật | Run log `events.jsonl`; báo cáo luôn được dựng lại từ log |
| Cấu hình dạng "row" có `id`, ghi đè theo `id` | `aitest.yml` gồm các row `id`/`name`/`config`/`disabled` |
| Plugin thiếu service phụ thuộc thì chờ, không ném lỗi | Khai báo `inject` cho mọi plugin |

Kernel tự viết một bộ nạp row tối giản (`packages/core/src/kernel.ts`), chưa dùng `@deepseek-ai/cordis-plugin-loader`. Lý do: loader của dsh gắn chặt với profile, bundle và patch layer, vượt nhu cầu của PoC. Định dạng row đã tương thích về ý tưởng, nên có thể chuyển sang loader đó khi cần hot reload cấu hình.

### 2.2. Agent nằm ngoài, công cụ nằm trong

Agent loop không chạy trong aitest. aitest đóng vai **ACP client** và **MCP host**:

1. Driver khởi chạy `kiro-cli acp` và giao tiếp qua stdio theo ACP.
2. Mỗi test case nhận một endpoint MCP riêng (`http://127.0.0.1:<port>/mcp/<token>`).
3. Runner truyền endpoint này vào `session/new` của ACP dưới dạng MCP server HTTP.
4. Kiro gọi tool qua endpoint đó; gateway chuyển lời gọi vào `ctx.actions.invoke`.

Thiết kế này có ba hệ quả:

- Đổi agent (Kiro, Claude Code, Gemini CLI...) chỉ cần đổi cấu hình driver, miễn agent hỗ trợ ACP.
- aitest quan sát được mọi lời gọi tool ở phía server, không phụ thuộc agent tự báo cáo.
- Kiro 2.26.1 khai báo `mcpCapabilities.http: true`, nên không cần process cầu nối stdio.

### 2.3. LLM không quyết định pass/fail

Đây là nguyên tắc quan trọng nhất của thiết kế. Nếu để LLM tự kết luận, nền tảng sẽ báo pass giả mỗi khi model "tưởng" là đúng.

Cơ chế xác định kết quả:

1. Plugin `verdict` lưu kết quả mỗi action thành evidence, kèm mã `evN` trả về cho agent.
2. Agent gọi `assert_expectation` với `expectId`, `evidenceId` và `path`.
3. Plugin tự đọc giá trị thật tại `path` trong evidence rồi so sánh. Agent không truyền giá trị thực tế.
4. Khi plan khai báo `check`, toán tử và giá trị mong đợi lấy từ plan; agent không thay đổi được.
5. Verdict của case được tính từ assertion của từng expectation.

| Verdict | Điều kiện |
|---|---|
| `pass` | Mọi expectation có assertion đạt |
| `fail` | Ít nhất một expectation có assertion không đạt |
| `inconclusive` | Có expectation chưa được assert, hoặc case không có expectation |
| `error` | Agent lỗi, mất kết nối hoặc vượt `timeout` |

**Giá trị mong đợi phải tính toán** (phí, tổng tiền, giá trần) dùng `check.expr` thay cho `check.value`, ví dụ `round(qty * price / 1000 * 0.0015, 2, HALF_UP)`. Plan cố định công thức; khi assert, agent truyền `inputs` chỉ ra evidence và path chứa từng biến; plugin `verdict` đọc giá trị thật qua `ctx.evidence` và tính trên BigDecimal trong core (`calculate`, dựa trên bigdecimal.js, cùng ngữ nghĩa `java.math.BigDecimal`). Agent không tự tính giá trị mong đợi, nên không có sai số tính nhẩm và không có lỗi chép số.

Quy tắc tính: `+ - * %` chính xác và giữ đủ phần thập phân; `/` chia không hết là lỗi, phải dùng `div(a, b, scale, MODE)`. **Không có cách làm tròn mặc định**: mọi hàm làm tròn (`round`, `roundStep`, `roundSig`, `div`, `sqrt`) bắt buộc ghi cách làm tròn (`HALF_UP`, `HALF_EVEN`, `FLOOR`…), vì mỗi tính năng có quy tắc riêng. Phép so sánh số (`eq`, `gt`…) dùng BigDecimal `compareTo`, không qua số thực. `action-http` parse JSON không mất chữ số: số vượt độ chính xác của `number` được giữ dạng chuỗi.

Ngoài assertion, agent dùng tool `calc` (biểu thức) và `round_number` (làm tròn một giá trị) của plugin `action-math`. Đầu vào nhận số, chuỗi số hoặc tham chiếu evidence; kết quả cũng là evidence. Bộ tính tự phân tích cú pháp, chỉ nhận số, biến, cách làm tròn, toán tử và một danh sách hàm cố định; không dùng `eval`.

Phần việc còn lại của agent là chọn đúng evidence và đúng path. Báo cáo hiển thị path và giá trị thật của mỗi assertion, nên người đọc kiểm tra lại được lựa chọn này.

## 3. Thành phần

```
packages/
  core/              Kiểu miền, danh mục event, service lõi, kernel nạp plugin
  plan-yaml/         Định dạng test plan *.plan.yaml
  mcp-gateway/       MCP server HTTP trong process, mỗi case một endpoint
  agent-acp/         Driver ACP (mặc định Kiro)
  runner/            Điều phối lượt chạy; prompt mặc định
  verdict/           Evidence, assert_expectation, note_step, tính verdict
  action-http/       Action http_request
  action-sqlite/     Action <namespace>_query cho SQLite
  action-mcp-proxy/  Nối MCP server bên ngoài thành action (Postgres, Playwright...)
  action-math/       Action calc, round_number: tính toán và làm tròn trên BigDecimal, biến lấy từ evidence
  action-wait/       Action wait_until: gọi lặp một action tới khi điều kiện đúng
  action-webhook/    Action webhook_create, webhook_wait: nhận callback từ hệ thống đích
  guard-basic/       Chặn SQL ghi, giới hạn host, chặn action theo tên
  reporters/         console, markdown, junit
  authoring/         Soạn plan cùng agent: service lõi và các plugin catalog, context-files, explore, validate, dry-run, save
  chat/              Cuộc chat soạn plan: log append-only, cầu nối ACP sang event, duyệt quyền
  web-host/          HTTP và WebSocket; registry method theo mẫu Remote của dsh
  plugin-manager/    Quản lý plugin, tool, MCP server từ giao diện; ghi patch layer
  knowledge/         Tri thức của nhóm: lỗi đã biết, quy ước, bài học (thư mục kb/)
  run-viewer/        Xem log lượt chạy trên giao diện, theo dõi lượt chạy đang diễn ra
  web-client/        Giao diện React + Vite; plugin phía client đăng ký vào slot
  cli/               Lệnh aitest
```

Các plugin chỉ phụ thuộc `@aitest/core` và cordis, không import lẫn nhau. Ngoại lệ: `runner` dùng kiểu của `mcp-gateway`; `authoring` dùng kiểu của `runner`; `chat` dùng `authoring`, `mcp-gateway` và `web-host`.

### 3.1. Service lõi

| Service | Khoá context | Vai trò |
|---|---|---|
| `ActionRegistry` | `ctx.actions` | Đăng ký action; lọc theo loại scope và namespace; chạy pipeline; ghi `action/start`, `action/call` kèm `view` |
| `PlanService` | `ctx.plans` | Đăng ký định dạng plan; chọn định dạng theo đuôi file |
| `AgentRegistry` | `ctx.agents` | Đăng ký driver agent |
| `PromptService` | `ctx.prompt` | Dựng prompt từ các section do plugin đóng góp |
| `RunLogService` | `ctx.runlog` | Tạo và đọc run log append-only |
| `McpGateway` | `ctx.gateway` | Mở endpoint MCP cho từng case |
| `Runner` | `ctx.runner` | Chạy test plan |
| `AuthoringService` | `ctx.authoring` | Phiên soạn plan, nguồn context, hướng dẫn cho agent, kiểm tra plan |
| `ChatService` | `ctx.chats` | Cuộc chat soạn plan với agent |
| `WebHost` | `ctx.web` | HTTP, WebSocket và registry method |
| `EvidenceReader` | `ctx.evidence` | Đọc giá trị thật trong evidence theo `{ evidenceId, path }`; plugin `verdict` cung cấp |
| `Kernel` | `ctx.kernel` | Row plugin lúc chạy: trạng thái, bật/tắt, cấu hình, thêm/gỡ, patch layer |

Action chạy trong một **scope** có loại `case` (test case), `authoring` (phiên soạn plan) hoặc `explore` (khảo sát chỉ đọc từ phiên soạn plan). Mỗi action khai báo `scopes`; mặc định là `case` và `explore`. Tool soạn plan khai báo `authoring`, nên agent chạy test không bao giờ thấy chúng, và ngược lại.

### 3.2. Danh mục event

| Event | Kiểu dispatch | Dùng để |
|---|---|---|
| `action/before` | waterfall | Guard: cho phép, từ chối, sửa tham số |
| `action/after` | waterfall | Bổ sung annotation, ví dụ `evidenceId` |
| `action/result` | emit | Quan sát kết quả cuối |
| `case/start` | parallel | Chuẩn bị dữ liệu trước case |
| `case/agent-update` | emit | Theo dõi luồng tin nhắn của agent |
| `case/verdict` | waterfall | Quyết định verdict |
| `case/end` | parallel | Dọn dẹp, thông báo |
| `run/event` | emit | Mỗi bản ghi mới trong run log |
| `run/report` | parallel | Reporter xuất báo cáo |
| `authoring/lint` | parallel | Bổ sung lỗi, cảnh báo khi kiểm tra plan |
| `chat/live` | emit | Token đang stream và trạng thái của cuộc chat; không ghi log |

Event ghi vào run log mà plugin dùng chung: `case/annotation` (`{ key, value }`) gắn thông tin vào case; `deriveReport` đưa vào `CaseReport.annotations`.

Listener waterfall không giữ quyết định thì phải `return next()`.

## 4. Luồng một lượt chạy

```mermaid
sequenceDiagram
  participant CLI
  participant Runner
  participant Gateway as MCP gateway
  participant Kiro as Kiro (ACP)
  participant Actions as ctx.actions
  participant Log as run log

  CLI->>Runner: run(plan)
  Runner->>Kiro: spawn kiro-cli acp, initialize
  loop mỗi test case
    Runner->>Gateway: expose(scope) → URL có token
    Runner->>Kiro: session/new (mcpServers: [gateway])
    Runner->>Kiro: session/prompt (prompt dựng từ các section)
    Kiro->>Gateway: tools/call http_request, db_query...
    Gateway->>Actions: invoke → action/before → execute → action/after
    Actions->>Log: action/call (+ evidenceId)
    Kiro->>Gateway: tools/call assert_expectation
    Gateway->>Actions: verdict đọc evidence, so sánh
    Actions->>Log: assert/result
    Kiro-->>Runner: stopReason end_turn
    Runner->>Log: case/end (verdict tính từ assertion)
  end
  Runner->>Log: run/end
  Runner->>CLI: deriveReport(log) → run/report → reporter
```

Mỗi case dùng một session ACP mới, nên ngữ cảnh của case trước không ảnh hưởng case sau. Toàn bộ lượt chạy dùng chung một process agent.

## 5. Định dạng test plan

### 5.1. Tiêu chí lựa chọn

| Tiêu chí | YAML | Markdown + frontmatter | Gherkin | JSON |
|---|---|---|---|---|
| QA không phải lập trình viên đọc và soạn được | Tốt | Rất tốt | Rất tốt | Kém |
| Kiểm tra schema trong IDE | Có (JSON Schema) | Chỉ phần frontmatter | Không | Có |
| Tách tiêu chí cố định (`check`) khỏi văn xuôi | Tự nhiên | Phải quy ước cú pháp riêng | Phải viết step definition | Tự nhiên |
| Parse ổn định, không phụ thuộc quy ước trình bày | Có | Không | Có | Có |
| Diff trong git dễ đọc | Tốt | Tốt | Tốt | Trung bình |
| Bước viết bằng ngôn ngữ tự nhiên cho AI | Có | Có | Có, nhưng gò theo Given/When/Then | Có, nhưng khó đọc |

Kết luận: chọn **YAML**. Phần `steps` là văn xuôi tự do cho agent, còn phần `expect[].check` có cấu trúc để verdict tính xác định. YAML là định dạng duy nhất đạt cả hai yêu cầu mà vẫn có JSON Schema cho IDE.

Định dạng là một plugin (`ctx.plans.registerFormat`). Vì vậy, có thể bổ sung Markdown hoặc Gherkin sau mà không đổi runner.

### 5.2. Cấu trúc

Xem ví dụ đầy đủ tại `examples/plans/order.plan.yaml` và schema tại `docs/plan.schema.json`.

| Trường | Ý nghĩa |
|---|---|
| `requires` | Namespace action được bật cho plan; action ngoài danh sách bị ẩn với agent |
| `vars` | Biến dùng trong steps qua `{{tên}}`; hỗ trợ `${env.NAME:-mặc định}` |
| `context` | Bối cảnh nghiệp vụ: bảng dữ liệu, ràng buộc |
| `cases[].steps` | Các bước bằng ngôn ngữ tự nhiên |
| `cases[].expect[].check` | Tiêu chí cố định; thiếu trường này thì agent tự chọn tiêu chí và báo cáo ghi `criteria: agent` |
| `cases[].expect[].check.expr` | Công thức tính giá trị mong đợi từ dữ liệu lúc chạy, thay cho `value` |
| `setup`, `teardown` | Bước fixture ở mức plan (áp dụng cho mọi case) và mức case; xem mục 6.2 |

## 6. Test integration và E2E

Test integration và E2E khác test API đơn lẻ ở ba điểm. Hệ thống xử lý bất đồng bộ, dữ liệu đầu vào phải ổn định giữa các lượt chạy, và có thêm kênh giao diện người dùng. Nền tảng đáp ứng ba điểm này bằng plugin, không đổi runner hay verdict.

| Nhu cầu | Thành phần | Ai thực hiện |
|---|---|---|
| Chờ trạng thái bất đồng bộ ổn định | `wait_until` (plugin `action-wait`) | Agent gọi; điều kiện đánh giá xác định |
| Nhận callback hệ thống đích gửi ra | `webhook_create`, `webhook_wait` (plugin `action-webhook`) | Agent gọi; nền tảng host endpoint |
| Chuẩn bị và dọn dữ liệu | `setup`, `teardown` trong plan | Runner chạy, không qua AI |
| Thao tác giao diện web | Playwright MCP qua `action-mcp-proxy` | Agent gọi các tool `browser_*` |

### 6.1. Xử lý bất đồng bộ

`wait_until` gọi lặp một action khác cho tới khi giá trị tại `path` thoả điều kiện, hoặc hết thời gian. Điều kiện dùng cùng bộ so khớp với assertion, nên kết quả chờ không phụ thuộc phán đoán của LLM.

- Mỗi lần gọi lặp đều đi qua guard và được ghi vào run log.
- Hết thời gian không phải lỗi: action trả `satisfied: false` kèm giá trị cuối và `evidenceId`. Agent vẫn assert như bình thường, và verdict ghi nhận `fail`.
- `action-wait` giới hạn thời gian chờ tối đa (`maxTimeout`, mặc định 300 giây) và khoảng cách tối thiểu giữa hai lần gọi (`minInterval`, mặc định 200 ms).

`webhook_create` tạo một URL riêng cho case. Agent truyền URL này cho hệ thống đích, ví dụ trong trường `callback_url`. `webhook_wait` chờ tới khi URL nhận đủ số request rồi trả về method, header và body. Sink tự đóng khi case kết thúc. Khi hệ thống đích chạy trong Docker hoặc trên máy khác, khai báo `publicBaseUrl` để hệ thống đích gọi tới được.

### 6.2. Fixture

Fixture là bước chuẩn bị hoặc dọn dẹp dữ liệu. Runner thực thi fixture một cách xác định, theo thứ tự sau:

1. `plan.setup`, rồi `case.setup`: lỗi ở bước nào thì case nhận verdict `error`, agent không được gọi.
2. Agent thực hiện case.
3. `case.teardown`, rồi `plan.teardown`: luôn chạy, kể cả khi case lỗi hoặc vượt thời gian.

```yaml
setup:
  - desc: Tạo sẵn một lệnh NEW
    action: dbadmin_query
    args:
      sql: "INSERT INTO orders (symbol, side, qty, price, status) VALUES ('MWG', 'SELL', 100, 61000, 'NEW') RETURNING id"
    save: { order_id: '$.rows[0].id' }
steps:
  - Gọi POST {{base_url}}/orders/{{order_id}}/cancel.
```

`save` lưu giá trị từ kết quả thành biến. Runner thay `{{order_id}}` trong steps, expectation và tham số fixture sau đó. Chuỗi chỉ gồm đúng một placeholder thì giữ nguyên kiểu của biến, ví dụ số nguyên.

Fixture được gọi mọi action đã đăng ký, không bị giới hạn bởi `requires`. Nhờ đó, kết nối ghi DB (`dbadmin`) chỉ dùng trong fixture, còn agent chỉ thấy kết nối chỉ đọc (`db`).

### 6.3. E2E qua trình duyệt

File `aitest.e2e.yml` kế thừa `aitest.yml` qua khoá `extends`, rồi thêm row Playwright MCP:

```yaml
extends: ./aitest.yml
plugins:
  - id: action-browser
    name: '@aitest/action-mcp-proxy'
    config:
      namespace: browser
      prefix: ''          # tool của Playwright đã có tiền tố browser_
      command: ./node_modules/.bin/playwright-mcp
      args: ['--headless', '--isolated', '--browser', 'chrome']
      exclude: [browser_run_code_unsafe, browser_evaluate, browser_file_upload]
```

Agent đọc trang bằng `browser_snapshot`, thao tác bằng `browser_fill_form`, `browser_click` theo `ref` trong snapshot. Kết quả snapshot là văn bản, nên expectation giao diện dùng toán tử `contains` hoặc `matches` với path `$`. Mỗi case E2E nên đối chiếu chéo với DB, vì giao diện có thể hiển thị đúng trong khi dữ liệu ghi sai.

Cấu hình loại bỏ các tool chạy mã tuỳ ý trong trang. Teardown `browser_close` giúp mỗi case bắt đầu với trình duyệt sạch.

### 6.4. Kiểm thử chính các năng lực này

Bộ kiểm thử tự động dùng agent kịch bản đi qua MCP gateway thật, không cần LLM:

| File | Nội dung |
|---|---|
| `packages/runner/tests/e2e.test.ts` | Luồng API, guard, replay báo cáo, nạp và gỡ plugin |
| `packages/runner/tests/integration.test.ts` | Webhook, `wait_until` có poll lặp, fixture có `save`, setup lỗi |
| `packages/runner/tests/browser.test.ts` | Điều khiển Chrome qua Playwright MCP; bỏ qua bằng `AITEST_SKIP_BROWSER=1` |

## 7. Soạn plan cùng agent

Người dùng chat với agent trên giao diện web; phía dưới, agent dùng nhiều tool để đọc tài liệu, khảo sát hệ thống, soạn, kiểm tra, chạy thử và lưu plan. Thiết kế học theo cách giao diện của dsh vận hành.

### 7.1. Học từ dsh

| Cơ chế của dsh | Trong aitest |
|---|---|
| Host và Client đều là cây plugin cordis | Host: `chat`, `web-host`, `authoring`, `plugin-manager`; Client: plugin đăng ký vào slot (`page`, `toolView`, `panel`) |
| Plugin Manager, patch layer `cordis.patch.yml` | Trang Plugin và Tool; patch layer `*.patch.yml` (mục 7.5) |
| Giao diện ↔ Host dùng giao thức riêng (API Gateway, `@Remote`), không dùng ACP | WebSocket `/ws`; plugin đăng ký method bằng `ctx.web.method(name, handler)` |
| Session log append-only; giao diện follow: snapshot rồi event mới, vá khoảng thiếu khi kết nối lại | Log của cuộc chat; `chats.subscribe` với `afterSeq`; client loại event trùng theo `seq` |
| Token đang stream đi kênh tạm, không vào log | Event `chat/live`; client xoá phần tạm khi `agent/message` tới |
| `presentCall`/`presentResult` thuần, dùng cả khi chạy lẫn khi phát lại | `present(args, outcome)` của action; Host ghi `view` vào `action/call` |
| `tools/pre-execute` trả `ask` → thẻ duyệt | `requestPermission` của ACP → `permission/request` → thẻ duyệt → `permission/decision` |
| Agent loop chạy trong Host | Agent loop ở Kiro qua ACP, sau seam `AgentDriver`; thêm driver tự gọi LLM mà không đổi giao diện |
| ACP chỉ dùng cho tự động hoá | ACP dùng cho Host ↔ agent, đúng mục đích một chương trình điều khiển agent |

```
Trình duyệt ⇄ WebSocket /ws ⇄ web-host ⇄ chat ⇄ ACP ⇄ Kiro (profile aitest-chat)
                                          ⇅ MCP gateway (scope authoring)
                         tool soạn plan → actions, plans, runner, verdict
```

### 7.2. Tool soạn plan

Mỗi nhóm tool là một plugin con của `@aitest/authoring`, đăng ký vào `ctx.actions` với `scopes: ['authoring']`. Mỗi plugin tự đóng góp một section vào hướng dẫn cho agent; gỡ plugin thì hướng dẫn tự bỏ phần tương ứng.

| Plugin | Tool | Ghi chú |
|---|---|---|
| `authoring` (lõi) | `get_authoring_guide`, `list_context_sources`, `read_context_source` | Hướng dẫn ghép từ section của plugin và `guide` của định dạng plan |
| `authoring/catalog` | `list_actions`, `list_plans`, `read_plan` | Chỉ đọc |
| `authoring/context-files` | — | Nguồn context từ file; nguồn khác (Confluence, OpenAPI) đăng ký qua `ctx.authoring.registerContextSource` |
| `authoring/explore` | `explore` | Chỉ nhận lời gọi chỉ đọc (`readOnly` hoặc `isReadOnlyCall`), vẫn đi qua guard |
| `authoring/validate` | `validate_plan` | Mỗi quy tắc là một listener `authoring/lint`, ví dụ namespace chỉ dành cho fixture không được nằm trong `requires` |
| `authoring/dry-run` | `dry_run`, `get_run_result` | Chạy nền bằng runner thật; kết quả rút gọn kèm gợi ý sửa plan |
| `authoring/save` | `save_plan` | Chỉ ghi `*.plan.yaml` trong thư mục cấu hình; plan phải hợp lệ |

### 7.3. Cuộc chat

Mỗi cuộc chat có một log `.aitest/chats/<id>/events.jsonl`, đồng thời là log của phiên soạn plan. Log ghi các event sau:

| Event | Nội dung |
|---|---|
| `chat/created`, `chat/renamed` | Tiêu đề; tiêu đề tự đặt theo tin nhắn đầu tiên |
| `user/message`, `agent/message`, `agent/thought` | Tin nhắn; chunk của agent được gộp thành một event |
| `agent/prompt` | Toàn bộ văn bản gửi agent, gồm chỉ dẫn vai trò ở lượt đầu |
| `agent/tool` | Tool call do ACP báo, gồm cả tool riêng của agent |
| `action/start`, `action/call` | Lời gọi tool soạn plan, kèm tham số, kết quả, `view`, pha (`agent` hoặc `user`) |
| `permission/request`, `permission/decision` | Yêu cầu dùng tool và quyết định (`policy` hoặc `user`) |
| `draft/edit` | Người dùng sửa bản nháp trên giao diện |
| `turn/start`, `turn/end` | Ranh giới một lượt; `turn/end` ghi `stopReason` hoặc lỗi |

Quy tắc duyệt: tool soạn plan chỉ đọc được duyệt tự động. `dry_run`, `save_plan` và mọi tool riêng của agent (ghi file, chạy shell) cần người dùng bấm duyệt.

Người dùng thao tác trực tiếp trên bảng "Plan đang soạn": sửa YAML, bấm Kiểm tra, Chạy thử, Lưu. Các thao tác này gọi cùng tool soạn plan với pha `user`, được ghi log, và được báo cho agent ở lượt kế tiếp. Nhờ vậy, agent không làm việc trên bản nháp cũ.

Khi Host khởi động lại, cuộc chat được dựng lại từ log. Lượt kế tiếp mở session agent mới và gửi kèm lịch sử hội thoại.

### 7.4. Kênh Kiro chat

Cùng bộ tool chạy được qua stdio bằng lệnh `aitest mcp`. Profile `.kiro/agents/aitest-author.json` dùng lệnh này, nên người dùng terminal chạy `kiro-cli chat --agent aitest-author`. Chỉ dẫn vai trò nằm ở `packages/authoring/agent-prompt.md`, dùng chung cho cả hai kênh.

### 7.5. Quản lý plugin và tool

Plugin `@aitest/plugin-manager` cung cấp hai trang **Plugin** và **Tool** trên giao diện, theo mẫu Plugin Manager và `ctx.tools.restrict()` của dsh.

| Thao tác | Cơ chế |
|---|---|
| Xem plugin: trạng thái, tầng khai báo, cấu hình, tool đóng góp | `ctx.kernel.rows`; tool thuộc plugin nào lấy từ fiber đã gọi `ctx.actions.register` |
| Bật, tắt plugin | `kernel.setEnabled` gỡ hoặc nạp lại fiber; plugin phụ thuộc tự chờ hoặc nạp lại theo `inject` |
| Sửa cấu hình | Form dựng từ `Config.toJSON()` của plugin; `kernel.configure` nạp lại, cấu hình lỗi thì quay về cấu hình cũ |
| Thêm plugin | Danh mục gồm subpath export của package `@aitest/*` và file trong `catalogDirs`; `kernel.add` chỉ ghi khi nạp thành công |
| Thêm MCP server | Form tạo row `@aitest/action-mcp-proxy`; tool của server xuất hiện ngay cho agent chạy test và cho `explore` |
| Bật, tắt từng tool | `ctx.actions.restrict(name)`: tool bị ẩn khỏi mọi scope và không gọi được |
| Chạy thử tool | Chỉ lời gọi chỉ đọc, qua scope `explore` hoặc `authoring`, đi qua guard |

**Patch layer.** Mọi thay đổi được kernel ghi vào `<tên cấu hình>.patch.yml` cạnh file cấu hình, ví dụ `aitest.web.patch.yml`. Patch layer nạp sau file cấu hình và ghi đè row cùng `id`, giống `cordis.patch.yml` của dsh. File cấu hình gốc không bị sửa; xoá patch layer là quay về cấu hình gốc. Row do giao diện thêm vào gỡ được; row của file cấu hình chỉ tắt được.

**Row bị khoá.** Các row mà giao diện phụ thuộc (`web`, `chat`, `authoring`, `gateway`, service lõi, chính `plugin-manager`) không tắt hoặc gỡ được từ giao diện; danh sách đặt trong `lockedRows`.

**Khởi động không nghiêm ngặt.** `aitest serve` khởi động với `strict: false`: plugin lỗi được hiển thị trạng thái "Lỗi" trên trang Plugin thay vì làm Host dừng. Các lệnh `run`, `validate` vẫn dừng ngay khi có plugin lỗi.

Mọi thao tác quản trị được ghi vào log kiểm toán `.aitest/manager/audit/events.jsonl`.

### 7.6. Tri thức của nhóm

Plugin `@aitest/knowledge` lưu tri thức tích luỹ thành file Markdown trong `kb/<loại>/<id>.md`: frontmatter YAML cộng nội dung. Ghi chú nằm trong git nên được xem lại qua pull request và có lịch sử thay đổi. Không có chỉ mục hay mô hình embedding: với vài chục tới vài trăm ghi chú, lọc theo loại và tính năng là đủ.

| Loại | Dùng cho | Cách nền tảng dùng |
|---|---|---|
| `bug` | Lỗi đã biết của hệ thống, kèm `cases` dạng `<mã plan>/<mã case>` và `status` | Case không đạt khớp lỗi đang mở → báo cáo ghi "lỗi đã biết"; không khớp → "lỗi mới". Case đạt khớp lỗi đang mở → "có thể đã sửa" |
| `convention` | Quy ước của nhóm | Tự vào hướng dẫn của agent soạn plan, mục "Quy ước bắt buộc" |
| `lesson` | Bài học khi soạn và chạy | Agent soạn plan tra bằng `kb_list`, `kb_read` theo tính năng |

Đánh dấu lỗi đã biết đi qua event chung `case/annotation` trong run log, nên báo cáo vẫn dựng lại được từ log. Agent soạn plan đề xuất ghi chú mới bằng `kb_propose`; tool này ghi dữ liệu nên luôn cần người dùng duyệt. **Agent chạy test không đọc tri thức**, để lỗi đã biết không làm agent bỏ qua bước kiểm tra.

Hướng dẫn cho agent dùng bản ghi chú nạp gần nhất. Ghi chú sửa trực tiếp trong file có hiệu lực sau lần gọi tool tri thức kế tiếp hoặc khi Host khởi động lại.

### 7.7. Xem log lượt chạy

Plugin `@aitest/run-viewer` cùng trang **Lượt chạy** cho người dùng xem agent đã làm gì trong từng case và vì sao ra kết quả đó. Theo mẫu `ui-trajectory` của dsh, mọi thứ dựng từ run log `events.jsonl`, không có kho dữ liệu riêng.

| Phần | Dựng từ event |
|---|---|
| Danh sách lượt chạy | `run/start`, `run/end`, `deriveReport`; gồm lượt chạy từ CLI và lượt chạy thử (`dryrun-*`) |
| Giải thích kết quả | `case/start` (expectation, tiêu chí), mọi `assert/result` (path, giá trị thật, công thức, `inputs`, các lần thử), `action/call` có `evidenceId` (nguyên văn evidence) |
| Dòng thời gian | `fixture/vars`, `agent/prompt`, `agent/update` (tin nhắn, suy nghĩ, tool riêng của agent kèm tham số và kết quả), `agent/permission`, `action/call`, `step/note`, `case/annotation`, `case/end` |
| Dữ liệu thô | Mọi event của case, lọc theo loại |

`runs.subscribe` gửi snapshot rồi đọc tiếp file theo vị trí byte cho tới khi gặp `run/end`; dòng ghi dở được để lại cho lần đọc sau. Nhờ vậy, Host theo dõi được cả lượt chạy CLI ở process khác. Tool riêng của agent (ví dụ Kiro đọc file) được ghi tham số và kết quả vào `agent/update`, rút gọn ở 4.000 ký tự.

### 7.8. Kiểm thử

| File | Nội dung |
|---|---|
| `packages/authoring/tests/authoring.test.ts` | Giới hạn tool theo scope, hướng dẫn, nguồn context, explore chỉ đọc, quy tắc kiểm tra, chạy thử, lưu |
| `packages/chat/tests/chat.test.ts` | Giao thức WebSocket thật với agent giả lập: stream, tool call kèm `view`, duyệt quyền, thao tác của người dùng, follow theo `seq`, khôi phục từ log |
| `packages/core/tests/calc.test.ts` | BigDecimal: chính xác với số lớn, giữ phần thập phân, chia không hết phải chọn cách làm tròn, đủ 8 cách làm tròn, so sánh không qua số thực, từ chối biểu thức không hợp lệ |
| `packages/action-math/tests/json.test.ts` | Parse JSON không mất chữ số |
| `packages/action-math/tests/math.test.ts` | `calc` với biến từ evidence; expectation dạng công thức bắt lỗi làm tròn số thực; kiểm tra công thức trong plan |
| `packages/knowledge/tests/knowledge.test.ts` | Tra và đề xuất ghi chú, quy ước trong hướng dẫn, đánh dấu lỗi đã biết, có thể đã sửa, lỗi mới; method cho trang Knowledge |
| `packages/run-viewer/tests/run-viewer.test.ts` | Danh sách, snapshot, các lần thử và evidence trong log, theo dõi file đang ghi dở ở process khác, chặn mã lượt chạy không hợp lệ |
| `packages/plugin-manager/tests/plugin-manager.test.ts` | Tool theo plugin sở hữu, bật/tắt, cấu hình lỗi được quay lui, thêm/gỡ từ danh mục, thêm MCP server, tắt tool, khôi phục từ patch layer |

## 8. Hướng dẫn mở rộng

Mọi điểm mở rộng đều theo cùng một cách: viết một module export plugin cordis, rồi thêm một row vào `aitest.yml`.

### 8.1. Thêm action nội bộ

```ts
import { z, type Context } from '@aitest/core'

export const name = 'action-kafka'
export const inject = ['actions']
export const Config = z.object({ brokers: z.array(z.string()).required() })

export function apply(ctx: Context, config: { brokers: string[] }) {
  ctx.actions.register({
    name: 'kafka_consume',
    namespace: 'kafka',
    readOnly: true,
    description: 'Đọc tối đa N bản tin mới nhất của một topic.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    async execute(args, { signal }) { /* ... */ },
  })
}
```

Ví dụ chạy được: `examples/plugins/action-clock.ts`.

### 8.2. Nối MCP server có sẵn

Không cần viết code. Thêm một row dùng `@aitest/action-mcp-proxy`:

```yaml
- id: action-pg
  name: '@aitest/action-mcp-proxy'
  config:
    namespace: pg
    command: npx
    args: ['-y', '@modelcontextprotocol/server-postgres', '${env.PG_URL}']
```

Tool `query` của server được đăng ký thành action `pg_query`. Lời gọi vẫn đi qua guard, evidence và run log.

### 8.3. Thêm guard

Lắng nghe `action/before`, trả `{ type: 'deny', reason }` để chặn, hoặc `next()` để chuyển tiếp. Xem `packages/guard-basic`.

### 8.4. Thêm agent

- Agent hỗ trợ ACP: thêm row `@aitest/agent-acp` với `name`, `command`, `args` khác.
- Agent không hỗ trợ ACP: viết plugin gọi `ctx.agents.register(driver)` theo interface `AgentDriver`. Ví dụ tham khảo là driver kịch bản trong `packages/runner/tests/support.ts`.

### 8.5. Thêm reporter

Lắng nghe `run/report` và nhận `RunReport` đã dựng sẵn. Xem `packages/reporters/src/*.ts`.

### 8.6. Thay service lõi

Khai báo row có cùng `id` với service lõi (`actions`, `plans`, `agents`, `prompt`, `runlog`). Ví dụ, để lưu run log vào object storage, thay row `runlog` bằng plugin của bạn.

### 8.7. Xếp lớp cấu hình

Khoá `extends` nhận một hoặc nhiều file cấu hình cha. Row của file con ghi đè row cùng `id` của file cha. `name` tương đối được phân giải theo thư mục của file khai báo row đó. Thứ tự đầy đủ: service lõi → file cha → file con → patch layer → ghi đè lúc khởi động (dùng trong bài test).

### 8.8. Thêm trang vào giao diện

Viết một plugin phía client đăng ký vào slot `page` (trang mới), `toolView` (thẻ hiển thị một `view.kind`) hoặc `panel` (bảng bên phải cuộc chat), rồi thêm vào danh sách `plugins` trong `packages/web-client/src/main.tsx`. Phía Host, plugin đăng ký method bằng `ctx.web.method(name, handler)`.

## 9. Kết quả kiểm chứng PoC

Các phép đo dưới đây thực hiện ngày 01/10/2026 trên macOS, Node 22.23, Kiro CLI 2.26.1, Google Chrome và Playwright MCP 0.0.83.

| Kịch bản | Kết quả |
|---|---|
| Bộ kiểm thử tự động với agent kịch bản (`pnpm test`) | 56/56 đạt, khoảng 10 s |
| Kiro chạy `order.plan.yaml` (API) | TC-01 pass, TC-02 pass, TC-03 fail đúng do lỗi cố ý; tổng 80,6 s |
| Kiro chạy `order-integration.plan.yaml` | IT-01 (webhook và `wait_until`) pass, IT-02 (fixture có `save`) pass; tổng 91,0 s |
| Kiro chạy `order-ui.plan.yaml` qua Chrome | E2E-01 pass, E2E-02 pass; tổng 89,8 s |
| Replay báo cáo từ `events.jsonl` | Báo cáo dựng lại trùng với báo cáo gốc |
| Guard chặn `DELETE` trên namespace `db` chỉ đọc | Action trả trạng thái `denied` |
| Kiro chat (`aitest-author`, không tương tác) soạn plan huỷ lệnh từ một câu yêu cầu | Đọc đặc tả, khảo sát DB, sửa lỗi theo `validate_plan`, chạy thử 3/3 pass, lưu plan |
| Giao diện web với Kiro, điều khiển bằng Playwright | Soạn plan đặt lệnh, người dùng duyệt chạy thử và lưu; ORD-02 fail và agent xác định đúng là lỗi của hệ thống |
| Trang Plugin và Tool, điều khiển bằng Playwright | Thêm MCP server `quote` qua form, tắt/bật plugin, thêm plugin từ danh mục, chạy thử `quote_get`, tắt `quote_list` |
| Kiro chạy `order-fee.plan.yaml` (expectation dạng công thức) | Kiro gắn `inputs` từ evidence DB ngay lần đầu; FEE-01 pass; FEE-02 fail đúng: nền tảng tính 1,55, API trả 1,54 do lỗi `toFixed` cài cố ý |
| Trang Lượt chạy theo dõi lượt chạy CLI của Kiro (process khác) | Danh sách hiện "Đang chạy" rồi cập nhật kết quả; phần giải thích của FEE-02 nêu công thức, `qty`, `price` đọc từ `ev3`, giá trị thật 1.54 tại `ev2 $.body.fee`, lỗi đã biết |
| Kiro chạy TC-03 với ghi chú lỗi `order-odd-lot-accepted` | Console và báo cáo ghi "lỗi đã biết" |
| Kiro soạn plan huỷ lệnh đã khớp trong cuộc chat | Tự gọi `kb_list`, áp dụng bài học về độ trễ callback, theo quy ước mã plan và `dbadmin`; chạy thử 2/2 pass; đề xuất một bài học mới, ghi sau khi được duyệt |
| Khởi động lại Host rồi nhờ Kiro dùng tool vừa thêm | MCP server nạp lại từ patch layer, `quote_list` vẫn tắt; Kiro gọi `quote_get` qua `explore` và trả đúng giá trần |

Phát hiện trong lần chạy đầu với Kiro: agent viết path `$.result.status` vì kết quả tool bọc giá trị trong trường `result`. Ba assertion đầu tiên không đạt, sau đó agent tự sửa path. Cách khắc phục đã áp dụng:

- `readPath` thử lại sau khi bỏ tiền tố `$.result` nếu path gốc không có giá trị.
- Trường trạng thái của gateway đổi tên thành `outcome` để không trùng với HTTP status.
- Báo cáo ghi mọi lần assert; cấu hình `verdict.allowRetry: false` bật chính sách chỉ tính lần đầu.

Sau khắc phục, mọi assertion của Kiro trong cả ba plan đều chọn đúng evidence và đúng path ngay lần đầu. Với plan giao diện, Kiro assert trên snapshot chụp sau khi gửi lệnh, không dùng snapshot trước đó.

Phát hiện khi soạn plan cùng agent:

- Kiro khai báo `dbadmin` trong `requires`, khiến agent chạy test thấy kết nối ghi DB. Khắc phục: quy tắc `fixtureOnlyNamespaces` của `authoring/validate` báo lỗi trường hợp này.
- Expectation không có `check` bị `plan-yaml` từ chối, trái với tài liệu. Nguyên nhân: schemastery điền object rỗng cho `check` rồi bắt buộc `op`. Đã sửa và thêm bài test.
- `${env.PORT:-4300}` luôn thành chuỗi nên schema số từ chối. Khắc phục: chuỗi chỉ gồm một placeholder được suy kiểu như YAML.

## 10. Rủi ro và đánh đổi

| Vấn đề | Đánh đổi hiện tại | Hướng xử lý |
|---|---|---|
| Agent chọn sai evidence hoặc path nhưng vô tình khớp giá trị | Báo cáo hiển thị path và giá trị thật để người đọc kiểm tra | Thêm `check.path` gợi ý trong plan; cảnh báo khi path trỏ vào evidence của action không liên quan |
| Cho phép assert lại làm lộ khả năng agent "thử tới khi đạt" | Mặc định cho phép để agent sửa path sai; báo cáo ghi số lần thử | Đặt `allowRetry: false` cho môi trường CI nghiêm ngặt |
| Kiro có thể nạp MCP server từ cấu hình người dùng | Chính sách `permission: gateway-only` từ chối tool ngoài gateway | Dùng Kiro agent profile riêng, không khai báo MCP server nào |
| Prompt bằng tiếng Việt | Kiro hiểu tốt trong PoC | Tách section prompt theo ngôn ngữ nếu cần |
| Assert `contains` trên snapshot toàn trang có thể đạt nhầm, ví dụ chữ VCB nằm trong ô nhập liệu chứ không nằm trong bảng | Kết hợp đối chiếu chéo với DB trong cùng case | Hướng dẫn agent chụp snapshot theo `target` của vùng cần kiểm tra; thêm toán tử so khớp theo vai trò phần tử |
| Trình duyệt dùng chung giữa các case | Teardown `browser_close` đưa trình duyệt về trạng thái sạch | Một process Playwright MCP cho mỗi case khi cần cô lập tuyệt đối |
| Một process agent cho cả lượt chạy | Tiết kiệm thời gian khởi động | Thêm tuỳ chọn mỗi case một process khi cần cô lập tuyệt đối |
| Agent loop chạy ở Kiro nên aitest không thấy suy luận nội bộ hay prompt hệ thống của Kiro | Ghi mọi thứ ACP gửi về và mọi văn bản aitest gửi đi | Thêm driver tự gọi LLM khi cần kiểm soát từng bước như dsh |
| Web host chưa có đăng nhập; ai mở được trang đều thêm được MCP server, tức là chạy được lệnh trên máy Host | Mặc định chỉ lắng nghe `127.0.0.1`; mọi thao tác ghi log kiểm toán | Thêm plugin xác thực và phân quyền quản trị trước khi mở cho nhóm |
| Thêm package npm mới chưa làm được từ giao diện | Danh mục chỉ gồm package đã cài và file cục bộ | Thêm thao tác cài package như `install_bundle` của dsh |
| Chạy thử trong cuộc chat khởi chạy thêm một process Kiro | Cách ly agent soạn plan với agent chạy test | Dùng chung process khi tải lớn |
| Hai người cùng mở một cuộc chat | Log đúng thứ tự nhưng có thể gửi chồng tin nhắn; Host từ chối tin nhắn khi agent đang làm việc | Thêm khoá theo người dùng khi có đăng nhập |

## 11. Lộ trình

1. **Ổn định lõi:** chạy song song nhiều case, tham số hoá case theo bảng dữ liệu, chia sẻ biến giữa các case.
2. **Action phổ biến:** Postgres, Kafka, Redis, gRPC; quản lý môi trường bằng Docker Compose hoặc Testcontainers ở fixture.
3. **Soạn plan:** nguồn context OpenAPI và Confluence, tool `ask_user` có cấu trúc như dsh, sinh plan hàng loạt từ đặc tả.
4. **Giao diện web:** đăng nhập, danh sách plan và lịch sử lượt chạy, xem chuỗi tool call của từng case, so sánh giữa các lượt chạy.
5. **Hot reload:** chuyển kernel sang `@deepseek-ai/cordis-plugin-loader` để thay plugin mà không khởi động lại.

## Thuật ngữ mới

| Thuật ngữ | Nhóm | Ghi chú |
|---|---|---|
| test plan, test case | A | Danh từ chỉ tài liệu kiểm thử; giữ nguyên |
| evidence | A | Kết quả action được lưu để đối chiếu |
| assertion | A | Một lần đối chiếu expectation với evidence |
| expectation | A | Kết quả mong đợi khai báo trong plan |
| verdict | A | Kết luận pass/fail/error/inconclusive của case |
| run log | A | Nhật ký append-only của một lượt chạy |
| plugin, action, guard, reporter, driver | A | Thành phần kiến trúc |
| scope | A | Phạm vi thực thi action: `case`, `authoring`, `explore` |
| slot | A | Điểm đăng ký thành phần giao diện phía client |
| lượt chạy | B | Dịch của "run" |
| fixture | A | Bước chuẩn bị hoặc dọn dẹp dữ liệu do runner chạy |
| webhook, callback, snapshot | A | Giữ nguyên |
