# AGENTS.md

aitest là nền tảng cho AI agent tự đọc test plan, tự thực thi các bước qua MCP và xuất báo cáo. Nền tảng dựng trên `@deepseek-ai/cordis` theo kiến trúc "mọi thứ là plugin" của DeepSeek Harness (dsh). Đọc [docs/architecture.md](docs/architecture.md) trước khi sửa `packages/`. Hướng dẫn cho người dùng cuối nằm ở [docs/user-guide.md](docs/user-guide.md).

## Mô hình hoạt động

aitest không chạy agent loop. aitest vừa là **ACP client** điều khiển agent bên ngoài (mặc định `kiro-cli acp`), vừa là **MCP host** cung cấp công cụ cho agent.

1. Runner nạp plan, chạy fixture `setup` một cách xác định.
2. Runner mở một endpoint MCP riêng cho case (`ctx.gateway.expose`) rồi truyền endpoint vào `session/new` của ACP.
3. Agent gọi tool qua endpoint; gateway chuyển mọi lời gọi vào `ctx.actions.invoke`, đi qua pipeline `action/before` → `execute` → `action/after`.
4. Agent gọi `assert_expectation`; plugin `verdict` tự đọc giá trị thật trong evidence và so sánh.
5. Runner chạy `teardown`, tính verdict, ghi `case/end`; cuối lượt chạy dựng `RunReport` từ run log và phát `run/report`.

Soạn plan cùng agent theo mô hình giao diện của dsh: trình duyệt ⇄ WebSocket ⇄ `web-host` ⇄ `chat` ⇄ ACP ⇄ Kiro. Tool soạn plan (`@aitest/authoring/*`) có `scopes: ['authoring']` và đi qua cùng MCP gateway, pipeline, log. Giao diện dựng hoàn toàn từ log của cuộc chat (mục 7 của tài liệu kiến trúc).

## Sơ đồ thư mục

```
packages/            @aitest/<tên> — mỗi package là một hoặc nhiều plugin cordis
  core/              kiểu miền, danh mục event, service lõi, kernel nạp plugin từ YAML, bộ so khớp
  plan-yaml/         định dạng *.plan.yaml
  mcp-gateway/       MCP server Streamable HTTP trong process, mỗi case một endpoint
  agent-acp/         driver ACP (Kiro mặc định)
  runner/            điều phối lượt chạy, fixture, prompt mặc định
  verdict/           evidence, assert_expectation, note_step, tính verdict; feedback: feedback_submit (agent góp ý cải thiện plan)
  action-http/       http_request
  action-sqlite/     <namespace>_query cho SQLite
  action-mcp-proxy/  nối MCP server ngoài (Postgres, Playwright...) thành action
  action-math/       calc, round_number: tính toán và làm tròn trên BigDecimal; biến lấy từ evidence
  action-wait/       wait_until cho xử lý bất đồng bộ
  action-webhook/    webhook_create, webhook_wait để nhận callback
  action-kafka/      kafka_read, kafka_wait_for: đọc theo mốc thời gian bằng consumer group tạm; gửi bản tin khi bật
  action-rabbitmq/   rabbitmq_tap, rabbitmq_wait_for: quan sát exchange bằng queue tạm; gửi bản tin khi bật
  guard-basic/       chặn SQL ghi, giới hạn host, chặn action theo tên
  reporters/         console, markdown, junit (mỗi subpath là một plugin)
  authoring/         soạn plan cùng agent: service lõi + plugin catalog, context-files, explore, validate, dry-run, save
  chat/              cuộc chat soạn plan: log, cầu nối ACP sang event, duyệt quyền
  web-host/          HTTP, WebSocket /ws, registry method
  plan-manager/      trang Plan: danh sách, chi tiết, chạy plan (plans.list/get/run)
  run-viewer/        lượt chạy (trang con của Plan): danh sách, giải thích kết quả, dòng thời gian, theo dõi lượt chạy đang diễn ra
  knowledge/         tri thức của nhóm trong kb/: tool kb_list/kb_read/kb_propose, quy ước vào hướng dẫn, đánh dấu lỗi đã biết
  context/           thư viện ngữ cảnh (ctx.library): mục lục context/, skill chuẩn Agent Skills (use_skill, read_skill_file), trang Ngữ cảnh
  memory/            bộ nhớ giữa các phiên (ctx.memory): ký ức cá nhân và nhóm, mục lục đầu phiên, memory_* tool, lịch sử và hoàn tác
  open-items/        việc còn mở (ctx.openItems): open_item_* tool, nhắc ở đầu phiên mới và mỗi lượt, bảng trong cuộc chat
  plugin-manager/    trang Plugin và Tool: bật/tắt, cấu hình, thêm/gỡ, thêm MCP server, tắt tool, chạy thử
  environments/      môi trường (ctx.envs): tool theo môi trường qua kernel.spawn, chặn ghi (policy.readOnly), plan.envs, envs.list
  inputs/            đầu vào của lượt chạy: người chạy điền, fill, agent prepare (provide_input, register_cleanup), default, blocked
  system-catalog/    catalog hệ thống (ctx.systems): biến {{system.url}}, section prompt, list_systems/describe_system, quy tắc kiểm tra;
                     brief: get_system_context (gói ngữ cảnh), new_plan_skeleton, kiểm tra bước `call:` theo OpenAPI
  tool-catalog/      list_tool_catalog, propose_tool: agent đề xuất thêm tool từ danh mục, người dùng duyệt trong chat
  web-client/        giao diện React + Vite; plugin client đăng ký vào slot (page, toolView, panel)
  cli/               lệnh aitest
examples/
  order-api/         ứng dụng mẫu: API, giao diện web, SQLite, sự kiện Kafka/RabbitMQ, lỗi cố ý ở kiểm tra lô chẵn
  plans/             plan mẫu: API, integration, E2E giao diện, sự kiện qua broker
  plugins/           plugin mẫu nạp theo đường dẫn tương đối
docs/                architecture.md, user-guide.md, plan.schema.json
kb/                  tri thức của nhóm: bug/, convention/, lesson/ (Markdown + frontmatter)
context/             tài liệu ngữ cảnh: agent soạn plan đọc; plan tham chiếu bằng contextRefs để agent chạy test đọc; frontmatter title, description, systems, inclusion: always
skills/              skill soạn plan: <tên>/SKILL.md theo chuẩn Agent Skills, kèm plan mẫu
memory/              bộ nhớ nhóm (ký ức dùng chung, vào git); bộ nhớ cá nhân ở .aitest/memory/<user>/
systems/             catalog hệ thống: <id>/service.yml (OpenAPI, kênh sự kiện, consumer, bảng, cột, giá trị, quy tắc nghiệp vụ)
envs/                môi trường: URL service, topic, ghi đè cấu hình tool, biến, chặn ghi; chọn bằng --env, AITEST_ENV hoặc trên giao diện
tool-catalog/        danh mục tool đã kiểm duyệt: plugin, tham số, mẫu cấu hình chỉ đọc và phần ghi
aitest.yml           cấu hình plugin mặc định
aitest.e2e.yml       kế thừa aitest.yml, thêm Playwright MCP
aitest.events.yml    kế thừa aitest.yml, thêm Kafka và RabbitMQ
aitest.codex.yml     kế thừa aitest.yml, Codex (codex-acp) làm agent chạy test; aitest.codex.web.yml: giao diện với Codex
aitest.web.yml       kế thừa aitest.yml, thêm web host, chat, plugin-manager và agent Kiro cho chat
aitest.*.patch.yml   patch layer do giao diện ghi (bị git bỏ qua)
.kiro/agents/        profile Kiro: aitest-author (Kiro chat + aitest mcp), aitest-chat (agent cho giao diện)
.aitest/             đầu ra lượt chạy (bị git bỏ qua)
```

## Lệnh

```sh
pnpm install                 # pnpm 11, node >=22.18
pnpm run typecheck           # tsc --noEmit cho Host và cho web-client
pnpm test                    # vitest; agent kịch bản, không gọi LLM; khoảng 10 s
AITEST_SKIP_BROWSER=1 pnpm test   # bỏ qua bài test trình duyệt khi máy không có Chrome
pnpm demo:api                # Order API mẫu ở cổng 4100
pnpm aitest validate <plan>
pnpm aitest run <plan> [--env staging] [--case A,B] [--agent kiro] [--input tên=giá-trị]   # gọi Kiro thật, tốn lượt dùng
pnpm aitest envs check       # nạp tool của từng môi trường, báo lỗi cấu hình
pnpm aitest -c aitest.e2e.yml run examples/plans/order-ui.plan.yaml
pnpm aitest report .aitest/runs/<id>/events.jsonl           # dựng lại báo cáo từ log
pnpm serve                   # build giao diện rồi chạy Host tại http://127.0.0.1:4300 (dist không nằm trong git)
pnpm web:dev                 # Vite dev server cho web-client, chuyển /ws tới Host ở cổng 4300
pnpm aitest mcp              # MCP server soạn plan qua stdio; stdout chỉ dành cho giao thức MCP
```

Chạy `typecheck` và `test` trước khi kết thúc mọi thay đổi code. Chỉ chạy với Kiro thật khi thay đổi ảnh hưởng tới nội dung agent nhìn thấy: prompt, mô tả tool, định dạng kết quả tool. Báo cáo lại kết quả đã chạy, kể cả khi thất bại.

## Bất biến kiến trúc

- **LLM không quyết định pass/fail.** Verdict chỉ được tính từ assertion do plugin `verdict` đánh giá trên evidence thật. Không thêm đường nào cho agent tự báo giá trị thực tế hoặc tự kết luận.
- **Agent không tự tính.** Giá trị mong đợi cần tính dùng `check.expr`, do `verdict` tính từ giá trị thật trong evidence bằng `calculate` của core. Phép tính khác của agent đi qua tool `calc`, `round_number`. Bộ tính không dùng `eval`; tra hàm chỉ qua `Object.hasOwn`.
- **Công thức là hàm thuần, xác định.** Ngôn ngữ biểu thức (`core/expr.ts`) không dùng `eval`, giới hạn số bước tính, chỉ đọc thuộc tính riêng của bản ghi. Công thức tự định nghĩa chỉ thấy tham số của nó; công thức của service có `examples` và được kiểm khi `validate`.
- **Số là BigDecimal, làm tròn luôn tường minh.** Không đổi số sang `number` để tính hoặc so sánh (`toBigDecimal`, `compareTo`). Không thêm cách làm tròn mặc định; chia không hết là lỗi.
- **Tiêu chí của plan là cố định.** Khi expectation có `check`, `op` và giá trị mong đợi luôn lấy từ plan; tham số của agent bị bỏ qua.
- **Run log là nguồn sự thật.** Mọi thông tin xuất hiện trong báo cáo phải dựng lại được từ `events.jsonl` qua `deriveReport`. Thông tin mới trong báo cáo đòi hỏi một loại event mới, ghi qua `scope.log`.
- **Mọi thao tác của agent đi qua gateway.** Không cấp cho agent MCP server nào khác ngoài endpoint của gateway. Tích hợp MCP server ngoài phải qua `action-mcp-proxy` để giữ guard, evidence và log.
- **Thực thi quyết định tại nơi thực thi.** Giới hạn `requires` và guard được kiểm tra trong `ActionRegistry.invoke`, không chỉ ở danh sách tool hay prompt. Kiểm thử từ chối phải gọi qua `invoke`.
- **Fixture không qua AI.** `setup`/`teardown` và `fill` của input do runner chạy; lỗi setup cho verdict `error` và không gọi agent; teardown luôn chạy. Agent chỉ chuẩn bị dữ liệu trong scope `prepare` (input có `prepare`): giá trị phải đọc từ evidence qua `provide_input`, dữ liệu tạo ra được dọn qua `register_cleanup`.
- **Plan không gắn với một môi trường.** Mọi thứ khác nhau giữa môi trường nằm trong `envs/<tên>.yml`; tool theo môi trường là row `<row>@<env>` do `ctx.envs` nạp, registry chọn theo `scope.env`. Không đọc `AITEST_ENV` trực tiếp trong plugin; dùng `scope.env` hoặc `ctx.envs.config.default`.
- **Môi trường chưa đủ điều kiện là `blocked`, không phải `fail`.** Input thiếu hoặc không thoả `require` chặn cả lượt chạy; case không được chạy.
- **Giao diện dựng từ log.** Mọi thứ giao diện hiển thị lâu dài phải là event trong log của cuộc chat; chỉ token đang stream đi qua `chat/live`. Thông tin hiển thị mới đòi hỏi event mới hoặc trường mới trong `view`.
- **Thay đổi lúc chạy đi vào patch layer.** Bật/tắt, cấu hình, thêm/gỡ plugin và tắt tool chỉ đi qua `ctx.kernel`; kernel ghi `*.patch.yml` khi plugin nạp thành công. Không sửa file cấu hình gốc từ code.
- **Mọi lời gọi tool của agent có lý do.** Gateway thêm `reason`, `step` vào schema và tách ra thành `intent` trước khi gọi `invoke`. Không bỏ cơ chế này: agent (Kiro) không gửi suy nghĩ qua ACP, nên đây là nguồn duy nhất giải thích vì sao agent lấy dữ liệu.
- **Chạy được trên macOS, Linux, Windows.** Khởi chạy process bằng `cross-spawn` (hoặc qua MCP SDK); kiểm tra đường dẫn bằng `isInside`; ghi đường dẫn hiển thị bằng `toPosix`; đọc file văn bản chấp nhận CRLF. CI chạy cả ba hệ điều hành.
- **Agent chạy test không đọc tri thức.** Tool `kb_*` chỉ có scope `authoring`; lỗi đã biết chỉ được dùng để phân loại kết quả trong báo cáo, qua `case/annotation`.
- **Bộ nhớ chỉ dành cho soạn plan, không chứa bí mật.** Tool `memory_*` chỉ có scope `authoring`. `ctx.memory.save` từ chối nội dung giống bí mật, ký ức gần trùng và bản ghi cũ hơn `expectedVersion`; mọi lần sửa, xoá giữ bản cũ trong `.history/`. Ghi bộ nhớ nhóm cần `scope.confirm`.
- **Bối cảnh chạy test có một nơi ghi.** Bảng, cột, giá trị, quy tắc nghiệp vụ của hệ thống nằm trong `systems/<id>/service.yml`; quy trình dùng chung nằm trong thư mục ngữ cảnh và được plan tham chiếu bằng `contextRefs`; `context` của plan chỉ chứa điều riêng của plan. Không đưa bối cảnh hệ thống vào `kb/`.
- **Ngữ cảnh nạp theo tầng.** Đầu phiên chỉ có mục lục (bộ nhớ, việc còn mở, tên và mô tả skill, tài liệu `inclusion: always`); nội dung đọc qua tool. Thêm ngữ cảnh bằng `ctx.authoring.introSection` (đầu phiên), `turnSection` (mỗi lượt) hoặc `guideSection`; `chat` không biết plugin nào đóng góp.
- **Duyệt trước khi ghi.** Tool soạn plan chỉ đọc được duyệt tự động; `dry_run`, `save_plan` và tool riêng của agent cần người dùng duyệt.
- **Agent chỉ thêm tool từ danh mục, qua người duyệt.** `propose_tool` dựng cấu hình từ mẫu trong `tool-catalog/`, không nhận cấu hình tự do. Tool tự duyệt qua `scope.confirm` (phía server) và từ chối khi scope không có người duyệt. Tool mới mặc định chỉ đọc; tham số bí mật chỉ nhận `${env.TÊN}`.
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
- **Plan không ghi địa chỉ.** Plan mới tham chiếu hệ thống qua `systems` và `{{<system>.url}}`; URL, topic, exchange nằm trong `systems/` và `envs/`. `envs/` không chứa bí mật.

## Kiểm thử

- Bài test nằm ở `packages/<tên>/tests/`. Test tích hợp dùng `setupHarness` trong `packages/runner/tests/support.ts`: dựng kernel từ `aitest.yml` thật, khởi chạy Order API với DB tạm và đăng ký agent kịch bản gọi tool qua MCP client thật.
- Plugin mới có test chạy qua cấu hình thật, không chỉ `ctx.plugin(...)` dựng tay.
- Registry mới có test chứng minh gỡ plugin thì đóng góp biến mất.
- Các file test chạy song song. Mỗi file dùng cổng riêng (4199, 4198, 4197...) và thư mục tạm riêng, dọn trong `afterAll`. Không dùng cổng 4190: fetch của Node chặn cổng này.
- Test cần hạ tầng ngoài (Kafka, RabbitMQ) bỏ qua khi thiếu biến môi trường (`KAFKA_BROKERS`, `RABBITMQ_URL`); CI chạy chúng trong job `brokers` với service container.
- Thay đổi nội dung agent nhìn thấy cần thêm một lần chạy Kiro thật; ghi số liệu vào mục kết quả kiểm chứng của tài liệu kiến trúc khi số liệu thay đổi.
- Đổi điều agent nhìn thấy (mô tả tool, hướng dẫn, prompt) thì rà cùng lúc mọi nơi dạy agent cùng điều đó: `skills/`, `context/`, `kb/` mẫu, plan mẫu. Phiên agent đang mở được nhắc đọc lại hướng dẫn nhờ dấu vân tay (`authoring.fingerprint`), nhưng skill và tài liệu lỗi thời thì vẫn dạy sai.

## Tài liệu

Tài liệu đi cùng thay đổi code trong cùng commit: README, tài liệu kiến trúc, hướng dẫn sử dụng, JSON Schema của plan và JSDoc liên quan. Mỗi sự thật chỉ có một nơi ghi chính; nơi khác liên kết tới.

## Commit

Chỉ commit khi người dùng yêu cầu. Commit message viết tiếng Việt theo chính sách ngôn ngữ, dòng đầu dưới 72 ký tự, mô tả thay đổi và lý do.

## Sửa file hướng dẫn này

`CLAUDE.md` là symlink tới `AGENTS.md` ở thư mục gốc và ở `packages/`; sửa file thật. Quy tắc riêng cho package nằm ở [packages/AGENTS.md](packages/AGENTS.md). Mỗi quy tắc phải đúng với code hiện tại; khi code đổi, cập nhật quy tắc trong cùng commit.
