# Hướng dẫn sử dụng aitest

Tài liệu dành cho người soạn và chạy test plan (QA, BA, lập trình viên). Thiết kế bên trong và cách viết plugin nằm ở [architecture.md](architecture.md).

## 1. aitest làm gì

Bạn mô tả test case bằng ngôn ngữ tự nhiên trong một file YAML. AI agent (mặc định là Kiro) đọc file, tự gọi API, truy vấn DB hoặc thao tác trình duyệt để thực hiện các bước. aitest ghi lại mọi thao tác và xuất báo cáo.

Kết luận pass/fail **không do AI quyết định**. Agent chỉ chỉ ra dữ liệu nào cần kiểm tra; aitest tự đọc giá trị thật và so sánh với tiêu chí bạn khai báo trong plan.

## 2. Cài đặt

### 2.1. Yêu cầu

| Thành phần | Phiên bản | Kiểm tra |
|---|---|---|
| Node.js | 22.18 trở lên | `node -v` |
| pnpm | 11 | `pnpm -v` |
| Kiro CLI | Đã đăng nhập; Windows cần Windows 11 | `kiro-cli acp --help` |
| Google Chrome | Chỉ cần cho test giao diện | Có trong thư mục Applications |

### 2.2. Hệ điều hành

| Hệ điều hành | Trạng thái | Ghi chú |
|---|---|---|
| macOS | Đã chạy thật: bộ test và Kiro | Bài test trình duyệt dùng Google Chrome |
| Linux | Đã chạy thật bộ test trong container Debian (arm64): 62/62 | Không có Google Chrome cho Linux arm64: cài Chromium bằng `node node_modules/.pnpm/playwright@*/node_modules/playwright/cli.js install --with-deps chromium` rồi đặt `AITEST_BROWSER=chromium`. Kiro CLI hỗ trợ Linux |
| Windows 11 | Đã rà soát và sửa các điểm phụ thuộc hệ điều hành; chưa chạy thật | Workflow CI `.github/workflows/ci.yml` chạy bộ test trên Windows khi đẩy repo lên GitHub. Kiro CLI hỗ trợ Windows 11 từ bản 2.0, cài bằng PowerShell |

### 2.3. Cài đặt

```bash
pnpm install
pnpm test        # khoảng 10 giây, không gọi AI; mọi bài test phải đạt
```

### 2.4. File cấu hình

| File | Dùng khi |
|---|---|
| `aitest.yml` | Test API, DB và integration |
| `aitest.e2e.yml` | Test giao diện web; kế thừa `aitest.yml` và thêm trình duyệt |

Hai file đọc địa chỉ hệ thống từ biến môi trường:

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `ORDER_API_URL` | Địa chỉ API, dùng trong `vars` của plan mẫu | `http://127.0.0.1:4100` |
| `ORDER_DB` | Đường dẫn file SQLite | `examples/order-api/orders.db` |
| `AITEST_BROWSER` | Trình duyệt cho test giao diện | `chrome` |
| `AITEST_ENV` | Môi trường của catalog hệ thống, đọc từ `envs/<tên>.yml` | `local` |

Khi áp dụng cho hệ thống của bạn, sửa các row `action-db`, `action-dbadmin` trong `aitest.yml` và biến trong `vars` của plan.

## 3. Chạy thử với ứng dụng mẫu

```bash
pnpm demo:api                                                        # terminal 1
pnpm aitest run examples/plans/order.plan.yaml                       # terminal 2
pnpm aitest run examples/plans/order-integration.plan.yaml
pnpm aitest -c aitest.e2e.yml run examples/plans/order-ui.plan.yaml
```

Plan `order.plan.yaml` có case TC-03 cố ý **fail**, vì ứng dụng mẫu có lỗi không kiểm tra lô chẵn. Kết quả này cho thấy aitest phát hiện được lỗi thật.

## 4. Lệnh

| Lệnh | Tác dụng |
|---|---|
| `pnpm aitest validate <plan>` | Kiểm tra cú pháp, schema và namespace action. Luôn chạy lệnh này sau khi sửa plan |
| `pnpm aitest run <plan>` | Chạy mọi case trong plan |
| `pnpm aitest run <plan> --case TC-01,TC-02` | Chỉ chạy các case liệt kê |
| `pnpm aitest run <plan> --agent <tên>` | Chọn agent khác với cấu hình |
| `pnpm aitest run <plan> --model <id>` | Chọn model của agent, ví dụ `claude-sonnet-4.5`; xem danh sách bằng `kiro-cli chat --list-models` |
| `pnpm aitest actions` | Liệt kê action agent có thể dùng |
| `pnpm aitest report <events.jsonl>` | Dựng lại báo cáo từ run log |
| `pnpm aitest -c aitest.web.yml serve` | Chạy giao diện web soạn plan cùng AI |
| `pnpm aitest mcp` | MCP server soạn plan qua stdio (Kiro chat dùng lệnh này) |
| `-c <file>` | Chọn file cấu hình, ví dụ `-c aitest.e2e.yml` |

Mã thoát của `run` bằng 0 khi mọi case đạt, bằng 1 khi có case không đạt, bằng 2 khi lỗi cấu hình hoặc plan.

## 5. Soạn test plan

### 5.1. Cấu trúc tối thiểu

Đặt tên file theo dạng `<tên>.plan.yaml`. Dòng đầu tiên bật gợi ý và kiểm tra schema trong VS Code (cần extension YAML của Red Hat).

```yaml
# yaml-language-server: $schema=../../docs/plan.schema.json
id: TP-ORDER-001                 # mã plan, duy nhất
name: Đặt lệnh qua Order API
requires: [http, db]             # nhóm action agent được dùng
vars:
  base_url: ${env.ORDER_API_URL:-http://127.0.0.1:4100}
context: |
  Bảng orders gồm id, symbol, side, qty, price, status.
cases:
  - id: TC-01
    title: Đặt lệnh mua hợp lệ
    steps:
      - Gọi POST {{base_url}}/orders với body {"symbol":"VNM","side":"BUY","qty":100,"price":70000}.
      - Truy vấn bảng orders theo id vừa nhận.
    expect:
      - id: http-201
        desc: API trả về HTTP 201
        check: { op: eq, value: 201 }
      - id: db-status
        desc: Bản ghi trong DB có status NEW
        check: { op: eq, value: NEW }
```

### 5.2. Các trường

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `id`, `name` | Có | Mã và tên plan |
| `requires` | Không | Namespace action được bật: `http`, `db`, `webhook`, `browser`... Xem bằng `aitest actions` |
| `inputs` | Không | Đầu vào của lượt chạy: người chạy điền, `fill`, agent `prepare`, `default`. Xem mục 6.1 |
| `systems` | Không | Hệ thống trong catalog mà plan dùng tới, ví dụ `[order-service]`; cung cấp biến `{{order-service.url}}` theo môi trường. Xem mục 5.9 |
| `vars` | Không | Biến dùng trong bước qua `{{tên}}`; hỗ trợ `${env.TÊN:-mặc định}` |
| `context` | Không | Bối cảnh nghiệp vụ: cấu trúc bảng, quy tắc, ý nghĩa trạng thái |
| `setup`, `teardown` | Không | Bước chuẩn bị và dọn dữ liệu, xem mục 6 |
| `cases[].id`, `title` | Có | Mã và tên case |
| `cases[].steps` | Có | Các bước, viết bằng ngôn ngữ tự nhiên |
| `cases[].expect` | Nên có | Kết quả mong đợi; case không có expectation luôn nhận `inconclusive` |
| `cases[].timeout` | Không | Giới hạn thời gian, đơn vị giây; mặc định 300 |
| `cases[].tags` | Không | Nhãn phân loại |

Namespace `verdict` (assert) và `wait` (`wait_until`) luôn được bật, không cần khai báo trong `requires`.

### 5.3. Viết bước sao cho agent hiểu đúng

| Nên | Tránh |
|---|---|
| Ghi rõ phương thức, URL và body: `Gọi POST {{base_url}}/orders với body {...}` | `Tạo một lệnh mua` |
| Nêu dữ liệu cần lấy cho bước sau: `Lấy id lệnh từ response` | Để agent tự đoán bước sau cần gì |
| Nói rõ bảng và điều kiện truy vấn: `Truy vấn bảng orders theo id vừa nhận` | `Kiểm tra DB` |
| Mỗi bước một hành động | Gộp nhiều thao tác vào một câu dài |
| Mô tả cấu trúc dữ liệu trong `context` | Để agent đoán tên cột |

Agent đọc toàn bộ `context`, `vars`, các bước và danh sách expectation trước khi bắt đầu.

### 5.4. Viết expectation

Mỗi expectation gồm `id`, `desc` và nên có `check`:

| Toán tử | Ý nghĩa | Ví dụ |
|---|---|---|
| `eq`, `ne` | Bằng, khác. Số và chuỗi số được coi là bằng nhau (`100` và `"100"`) | `{ op: eq, value: 201 }` |
| `gt`, `gte`, `lt`, `lte` | So sánh số | `{ op: gte, value: 1 }` |
| `contains` | Chuỗi chứa chuỗi con, hoặc mảng chứa phần tử | `{ op: contains, value: "Đã đặt lệnh" }` |
| `matches` | Khớp biểu thức chính quy | `{ op: matches, value: "^ORD-\\d+$" }` |
| `exists`, `not_exists` | Có giá trị hoặc không có giá trị | `{ op: exists }` |

Có hai cách khai báo:

- **Có `check`** (khuyến nghị): tiêu chí cố định, agent không thay đổi được. Báo cáo ghi `criteria: plan`.
- **Không có `check`**: agent tự chọn toán tử và giá trị mong đợi dựa trên `desc`. Báo cáo ghi `criteria: agent`. Chỉ dùng khi tiêu chí khó biểu diễn bằng một giá trị.

**Giá trị mong đợi cần tính toán** (phí, tổng tiền, phần trăm, làm tròn): viết công thức trong `expr` thay vì tự tính sẵn ra số.

```yaml
- id: fee-correct
  desc: Phí trong response đúng công thức
  check: { op: eq, expr: "round(qty * price / 1000 * 0.0015, 2, HALF_UP)" }
```

Khi chạy, agent chỉ ra nơi chứa giá trị thật của từng biến (`qty`, `price`); nền tảng tính trên **BigDecimal** (cùng cách tính với `java.math.BigDecimal`) rồi so sánh. Báo cáo ghi công thức, giá trị từng biến và kết quả tính. `op` của công thức phải là `eq`, `ne`, `gt`, `gte`, `lt`, `lte`.

**Quy tắc tính:**

| Phép tính | Hành vi |
|---|---|
| `+ - * %` | Luôn chính xác, giữ đủ phần thập phân: `1.50 * 1.0 = 1.500` |
| `/` | Chính xác nếu chia hết (`1 / 8 = 0.125`); không chia hết (`1 / 3`) là lỗi, phải dùng `div(a, b, scale, MODE)` |
| So sánh | Theo giá trị: `1.5`, `"1.50"`, `1.500` bằng nhau; không qua số thực |
| Số lớn trong response API | Số có nhiều chữ số hơn kiểu number chứa được giữ dạng chuỗi, không mất chữ số |

**Làm tròn: không có cách mặc định, mỗi test tự chọn theo đặc tả.**

| Hàm | Ý nghĩa | Ví dụ |
|---|---|---|
| `round(x, scale, MODE)` | Làm tròn tới `scale` chữ số thập phân; scale âm làm tròn tới hàng chục, trăm | `round(1.545, 2, HALF_EVEN)` = 1.54 |
| `roundStep(x, step, MODE)` | Làm tròn tới bội số của bước (bước giá, lô) | `roundStep(70000 * 1.07, 100, FLOOR)` = 74900 |
| `roundSig(x, digits, MODE)` | Làm tròn tới số chữ số có nghĩa | `roundSig(123.456, 4, HALF_UP)` = 123.5 |
| `floor`, `ceil`, `trunc(x, scale)` | Viết tắt của `FLOOR`, `CEILING`, `DOWN` | `ceil(2.123, 2)` = 2.13 |
| `div(a, b, scale, MODE)`, `sqrt(x, scale, MODE)` | Phép chia, căn có làm tròn | `div(1, 3, 4, HALF_UP)` = 0.3333 |

| MODE | Cách làm tròn | 1.545 → 2 chữ số | -1.545 → 2 chữ số |
|---|---|---|---|
| `HALF_UP` | Gần nhất; .5 làm tròn xa số 0 | 1.55 | -1.55 |
| `HALF_DOWN` | Gần nhất; .5 làm tròn về số 0 | 1.54 | -1.54 |
| `HALF_EVEN` | Gần nhất; .5 làm tròn về số chẵn (làm tròn ngân hàng) | 1.54 | -1.54 |
| `UP` | Xa số 0 | 1.55 | -1.55 |
| `DOWN` | Về số 0 (cắt bỏ) | 1.54 | -1.54 |
| `CEILING` | Lên phía dương | 1.55 | -1.54 |
| `FLOOR` | Xuống phía âm | 1.54 | -1.55 |
| `UNNECESSARY` | Không được làm tròn; báo lỗi nếu cần | lỗi | lỗi |

Hàm khác: `abs`, `min`, `max`, `sum`, `avg` (chính xác, hoặc báo lỗi nếu chia không hết), `pct(x, p)`.

Agent có tool `calc` (tính biểu thức) và `round_number` (làm tròn một giá trị theo `scale`, `step` hoặc số chữ số có nghĩa, với MODE bắt buộc) cho mọi phép tính khác, và được hướng dẫn không tự tính nhẩm.

Mỗi expectation chỉ nên kiểm tra **một giá trị**. Ví dụ, tách "status là NEW và qty là 100" thành hai expectation.

### 5.5. Kiểm tra trước khi chạy

```bash
pnpm aitest validate examples/plans/order.plan.yaml
```

Lệnh báo lỗi khi YAML sai cú pháp, thiếu trường bắt buộc, trùng mã case hoặc mã expectation. Lệnh cũng cảnh báo khi `requires` chứa namespace chưa có action nào đăng ký.

### 5.6. Soạn plan cùng AI

Thay vì tự viết YAML, bạn có thể mô tả tính năng bằng lời và để agent soạn plan.

#### Trên giao diện web

```bash
pnpm web:build
pnpm aitest -c aitest.web.yml serve     # mở http://127.0.0.1:4300; đổi cổng bằng AITEST_WEB_PORT
```

| Vùng | Chức năng |
|---|---|
| Cột trái | Danh sách cuộc chat; tiêu đề tự đặt theo tin nhắn đầu tiên |
| Đầu cuộc chat | Chọn **model** cho cuộc chat; danh sách lấy từ agent. Đổi model áp dụng cho các tin nhắn sau và được ghi vào hội thoại |
| Cột giữa | Hội thoại; mỗi tool agent dùng hiện thành một thẻ, bấm để xem chi tiết |
| Cột phải | "Plan đang soạn": YAML mới nhất, kết quả kiểm tra, kết quả chạy thử; nút "Mở plan có sẵn" và ô chọn case chạy thử |

Cách làm việc hiệu quả:

1. Mô tả tính năng và các trường hợp cần kiểm thử. Ví dụ: "Soạn test plan cho mục 3 trong đặc tả: huỷ lệnh NEW thành công, huỷ lệnh đã huỷ bị từ chối 409."
2. Trả lời câu hỏi của agent nếu có.
3. Khi agent xin phép **chạy thử** hoặc **lưu plan**, thẻ duyệt hiện trong hội thoại. Bấm "Cho phép" hoặc "Từ chối". Các tool chỉ đọc (đọc tài liệu, khảo sát, kiểm tra) không cần duyệt.
4. Góp ý bằng lời, hoặc sửa YAML trực tiếp ở cột phải rồi bấm "Kiểm tra", "Chạy thử", "Lưu". Agent được báo về phần bạn sửa ở tin nhắn tiếp theo.

Khi chạy thử phát hiện case không đạt, agent phân biệt plan viết chưa rõ với lỗi thật của hệ thống. Plan không bị sửa để che lỗi của hệ thống.

**Sửa hoặc chạy thử plan có sẵn.**

1. Bấm "Mở plan có sẵn" ở cột phải, gõ để lọc theo tên, mã plan, mã hoặc tên case, đường dẫn, rồi chọn plan. Mỗi dòng ghi tên, mã, danh sách case; đường dẫn file ở cuối. Plan đang lỗi cú pháp vẫn mở được để sửa.
2. Plan trở thành bản nháp và được kiểm tra ngay. Cuộc chat mới đổi tiêu đề thành "Plan <đường dẫn>".
3. Nhờ agent sửa, ví dụ "Thêm case huỷ lệnh đã huỷ trả 409 rồi chạy thử riêng case mới". Agent nhận nguyên nội dung plan ở tin nhắn tiếp theo.
4. Muốn tự chạy thử, bỏ chọn các case không cần ở dòng "Case chạy thử" rồi bấm "Chạy thử". Mỗi lần chạy thử có tối đa 3 case.
5. Plan nằm trong `plans/` được ghi đè tại chỗ khi bấm "Lưu". Plan ở nơi khác, ví dụ `examples/plans/`, được lưu thành bản mới trong `plans/`.

Mở plan khác sẽ thay bản nháp hiện tại. Khi bản nháp có thay đổi chưa lưu, bộ chọn hiện cảnh báo trước.

#### Trên terminal với Kiro chat

```bash
kiro-cli chat --agent aitest-author
```

Kiro dùng cùng bộ tool qua lệnh `aitest mcp`. Kiro hỏi xác nhận trước khi chạy thử và lưu plan.

#### Cung cấp tài liệu cho agent

Agent đọc tài liệu khai báo ở row `authoring-context` trong `aitest.yml`. Thêm đặc tả nghiệp vụ, mô tả API, mô tả dữ liệu của hệ thống bạn vào `sources`:

```yaml
- id: authoring-context
  name: '@aitest/authoring/context-files'
  config:
    sources:
      - id: payment-spec
        title: Đặc tả thanh toán
        paths: [docs/payment/SPEC.md, docs/payment/openapi.yaml]
```

Tài liệu càng rõ ràng, plan agent soạn càng ít phải sửa.

### 5.7. Quản lý plugin và tool trên giao diện

Khi chạy `pnpm aitest -c aitest.web.yml serve`, thanh điều hướng có thêm hai trang **Plugin** và **Tool**.

**Trang Plugin:**

| Thao tác | Cách làm |
|---|---|
| Xem trạng thái | Mỗi thẻ ghi "Đang chạy", "Đã tắt", "Lỗi" (kèm lý do) hoặc "Chờ service", cùng các tool plugin đóng góp |
| Bật, tắt | Công tắc trên thẻ. Plugin giao diện phụ thuộc vào thì bị khoá |
| Sửa cấu hình | "Cấu hình" → sửa theo form (có mô tả từng trường) hoặc chế độ JSON → "Lưu và nạp lại". Cấu hình sai thì plugin giữ cấu hình cũ và báo lỗi |
| Thêm plugin | "+ Thêm plugin" → chọn từ danh mục → đặt mã row và cấu hình → "Thêm plugin" |
| Thêm MCP server | "+ Thêm MCP server" → tab **Dán cấu hình** hoặc **Điền form**. Tool của server hiện ngay trên trang Tool và dùng được trong plan với `requires: [<namespace>]` |
| Gỡ | Chỉ plugin thêm từ giao diện mới gỡ được; plugin trong file cấu hình thì tắt |

**Dán cấu hình MCP đang dùng.** Chép nội dung `mcp.json` từ Claude Desktop, Claude Code, Cursor, Kiro hoặc VS Code (`mcpServers`, `servers`), hoặc chỉ một đoạn `"tên": {...}`. JSON có comment hay dấu phẩy thừa vẫn đọc được. Bấm "Đọc cấu hình" để xem trước từng server:

- Namespace được đề xuất từ tên server và sửa được; server trùng namespace có sẵn được đánh số thêm.
- Giá trị trong `env`, `headers` có dạng bí mật (token, key, password) được che. Mỗi giá trị có lựa chọn "dùng `${env.TÊN}`". Lựa chọn này bật sẵn khi biến đã có trên Host. Khi bỏ chọn, giá trị nguyên văn được ghi vào file patch; file này không được commit.
- Tham chiếu `${TÊN}`, `${env:TÊN}` của công cụ khác được đổi sang `${env.TÊN}`.
- Server có `disabled` được bỏ chọn sẵn. Server chỉ hỗ trợ SSE nhận cảnh báo, vì aitest dùng Streamable HTTP.

Bấm "Thêm N server". Mỗi server được kết nối thử: server lỗi được báo riêng và không được ghi, các server khác vẫn được thêm.

Ví dụ thêm MCP server bảng giá mẫu: namespace `quote`, lệnh `node`, tham số mỗi dòng một giá trị: `--import`, `tsx`, `examples/mcp/quote-server.ts`.

**Trang Tool:** liệt kê mọi tool theo namespace, kèm plugin sở hữu, nhãn "chỉ đọc", loại scope (`case`: agent chạy test; `authoring`: agent soạn plan; `explore`: khảo sát).

- Công tắc tắt một tool: tool biến mất với cả agent chạy test lẫn agent soạn plan.
- Mở một tool để xem mô tả, input schema, và **chạy thử** với tham số JSON. Chỉ lời gọi chỉ đọc chạy thử được.

**Thay đổi được lưu ở đâu.** Mọi thay đổi được ghi vào `aitest.web.patch.yml` cạnh file cấu hình. File cấu hình gốc không bị sửa. Xoá file patch rồi khởi động lại là quay về cấu hình gốc. Muốn đưa thay đổi thành cấu hình chung của nhóm, chép row từ file patch sang `aitest.yml`.

**Thêm tool ngay trong cuộc chat.** Khi plan cần kiểm tra một hệ thống mà nền tảng chưa có tool, ví dụ Kafka, agent đề xuất thêm tool từ danh mục đã kiểm duyệt (`tool-catalog/*.yml`).

1. Agent hỏi các tham số còn thiếu, ví dụ địa chỉ broker.
2. Thẻ duyệt hiện lý do, quyền (chỉ đọc hoặc đọc và ghi), tool sẽ bật, biến môi trường cần có, và **cấu hình nguyên văn** sẽ ghi vào file patch.
3. Bấm "Cho phép" thì tool được nạp ngay. Agent gọi thử một tool chỉ đọc để kiểm tra kết nối, rồi dùng namespace mới trong `requires`.

Quy tắc của luồng này:
- Mật khẩu và URL có mật khẩu **không nhập vào chat**. Đặt biến môi trường trước khi khởi động Host, ví dụ `RABBITMQ_URL=amqp://user:pass@host:5672`. Agent chỉ ghi tham chiếu `${env.RABBITMQ_URL}`.
- Tool mặc định chỉ đọc. Muốn agent gửi bản tin hoặc ghi dữ liệu, nói rõ trong chat; thẻ duyệt ghi "đọc và ghi" bằng chữ đỏ.
- Tool thêm qua chat là row trong `aitest.web.patch.yml`, gỡ được trên trang Plugin.
- Danh mục hiện có: Kafka, RabbitMQ, PostgreSQL, trình duyệt (Playwright). Cách thêm mục mới: xem `docs/architecture.md`, mục "Đưa vào danh mục tool".

### 5.8. Tri thức của nhóm (Knowledge)

Trang **Knowledge** lưu những điều nhóm học được, để lần sau không phải phát hiện lại. Mỗi ghi chú là một file Markdown trong `kb/`, nên cũng sửa được trực tiếp trong repo và xem lại qua pull request.

| Loại | Khi nào ghi | Tác dụng |
|---|---|---|
| **Lỗi đã biết** | Hệ thống sai so với đặc tả và chưa sửa | Khai báo case liên quan (`TP-ORDER-001/TC-03`). Case đó không đạt thì báo cáo ghi "lỗi đã biết" thay vì "lỗi mới". Khi lỗi được sửa, đổi trạng thái sang "Đã sửa" |
| **Quy ước** | Nhóm thống nhất cách làm | Agent soạn plan luôn đọc và áp dụng |
| **Bài học** | Điều rút ra khi soạn hoặc chạy thử | Agent soạn plan tra theo tính năng trước khi soạn |

Ghi chú được tạo theo ba cách:
- Tạo trên trang Knowledge: "+ Ghi chú mới".
- Agent đề xuất trong cuộc chat soạn plan, thường sau khi chạy thử phát hiện lỗi hệ thống. Thẻ duyệt hiện ra; bấm "Cho phép" thì ghi chú mới được ghi.
- Viết file trực tiếp trong `kb/<loại>/<id>.md` theo mẫu của các file có sẵn.

Đọc báo cáo: cột "Ghi chú" của bảng tổng hợp ghi "lỗi đã biết: <mã>" hoặc "**lỗi mới**" cho case không đạt. Case đạt mà vẫn khớp một lỗi đang mở được ghi "có thể đã sửa": kiểm tra lại rồi đổi trạng thái ghi chú.

### 5.9. Catalog hệ thống

Catalog mô tả các hệ thống dưới kiểm thử một lần, để mọi plan dùng lại. Plan tham chiếu hệ thống theo tên, không ghi URL, topic hay exchange.

| Nơi | Chứa gì | Đổi khi |
|---|---|---|
| `systems/<id>/service.yml` | Hợp đồng của service: operation HTTP (từ OpenAPI), kênh sự kiện, consumer, dữ liệu, tài liệu | Service đổi API hoặc sự kiện |
| `envs/<tên>.yml` | URL của từng service, ánh xạ broker → namespace tool | Đổi môi trường |
| Plan | `systems: [<id>]` và các bước theo tên | Đổi kịch bản |

**Khai báo một service.** Tạo thư mục trùng với `id`:

```yaml
# systems/order-service/service.yml
id: order-service
title: Order API
owner: team-oms
docs: [../../examples/order-api/SPEC.md]
http:
  openapi: ../../examples/order-api/openapi.yaml   # operation lấy theo operationId
events:
  - id: order-events                # kênh sự kiện: đơn vị hợp đồng
    kind: kafka                     # hoặc rabbitmq, khi đó dùng exchange
    broker: kafka-main              # tên logic; envs/<tên>.yml ánh xạ sang namespace tool
    topic: order-events
    correlation: $.value.orderId    # path lọc đúng bản tin của lượt chạy
    messages: [{ name: order.created }, { name: order.cancelled }]
consumers:                          # đơn vị xử lý và hệ quả quan sát được
  - group: order-executor
    effects: [orders.status chuyển NEW → FILLED]
data:
  - { namespace: db, tables: [orders] }
```

Service chưa có OpenAPI thì khai báo operation trực tiếp: `http.operations.createOrder: { method: POST, path: /orders, summary: Đặt lệnh }`. Operation khai báo trực tiếp ghi đè operation cùng id lấy từ OpenAPI.

**Khai báo môi trường.** File `envs/<tên>.yml` không chứa bí mật; bí mật nằm trong cấu hình của tool qua `${env.TÊN}`.

```yaml
# envs/staging.yml
systems:
  order-service: { url: https://orders.staging.example.com }
brokers:
  kafka-main: { namespace: kafka }
```

Chọn môi trường khi chạy: `AITEST_ENV=staging pnpm aitest run <plan>`.

**Dùng trong plan.**

```yaml
requires: [http, kafka]
systems: [order-service]
cases:
  - steps:
      - Gọi order-service.createOrder (POST {{order-service.url}}/orders) với body {...}; lấy id lệnh.
      - Chờ sự kiện order.created trên order-service.order-events của lệnh vừa tạo, tối đa 20 giây.
```

Khi chạy, agent nhận thêm mục "Hệ thống liên quan" trong prompt: base URL, danh sách operation, topic hoặc exchange, namespace tool cần dùng, path lọc bản tin, consumer và bảng dữ liệu. Biến của plan (`vars`) cùng tên được ưu tiên hơn biến của catalog.

`aitest validate` và `validate_plan` kiểm tra:

| Lỗi | Mức |
|---|---|
| `systems` chứa hệ thống không có trong catalog, hoặc file `service.yml` lỗi | error |
| `{{<system>.<khoá>}}` với hệ thống chưa khai báo trong `systems`, hoặc khoá khác `url` | error |
| Bước nhắc `<system>.<tên>` không phải operation hay kênh sự kiện | warning |
| Kênh sự kiện được dùng nhưng nền tảng chưa có tool cho namespace của kênh | error |
| Kênh sự kiện được dùng, tool đã có nhưng namespace chưa có trong `requires` | warning |
| Môi trường hiện tại không có URL cho hệ thống | warning |

Agent soạn plan đọc catalog bằng `list_systems` và `describe_system` (schema request, response, danh sách bản tin), nên viết bước đúng tên operation và đúng trường ngay lần đầu. Mỗi kênh sự kiện kèm trạng thái tool: namespace cần dùng và đã có tool hay chưa. Khi chưa có, agent đề xuất thêm tool từ danh mục (mục 5.7) trước khi viết bước.

## 6. Chuẩn bị và dọn dữ liệu

Dùng `setup` và `teardown` để mỗi case bắt đầu từ trạng thái biết trước. aitest chạy các bước này theo đúng thứ tự khai báo, **không qua AI**.

```yaml
setup:                       # chạy trước MỖI case
  - desc: Xoá lệnh MWG cũ
    action: dbadmin_query
    args: { sql: "DELETE FROM orders WHERE symbol = 'MWG'" }

cases:
  - id: IT-02
    title: Huỷ lệnh có sẵn
    setup:                   # chạy sau setup của plan
      - desc: Tạo sẵn một lệnh NEW
        action: dbadmin_query
        args:
          sql: "INSERT INTO orders (symbol, side, qty, price, status) VALUES ('MWG', 'SELL', 100, 61000, 'NEW') RETURNING id"
        save: { order_id: '$.rows[0].id' }
    steps:
      - Gọi POST {{base_url}}/orders/{{order_id}}/cancel.
    teardown:
      - action: dbadmin_query
        args: { sql: "DELETE FROM orders WHERE id = ?", params: ["{{order_id}}"] }
```

Quy tắc:

| Quy tắc | Chi tiết |
|---|---|
| Thứ tự | `plan.setup` → `case.setup` → agent → `case.teardown` → `plan.teardown` |
| Setup lỗi | Case nhận `error`, agent không được gọi |
| Teardown | Luôn chạy, kể cả khi case lỗi hoặc vượt thời gian |
| `save` | Lưu giá trị từ kết quả thành biến; path giống path của assertion |
| Biến | `{{tên}}` dùng được trong bước, expectation và tham số fixture sau đó |
| Action | Fixture gọi được mọi action, kể cả action không có trong `requires` |

Kết nối DB được tách làm hai: `db_query` chỉ đọc dành cho agent, còn `dbadmin_query` có quyền ghi và chỉ dùng trong fixture. Không khai báo `dbadmin` trong `requires`, để agent không thể sửa dữ liệu.

### 6.1. Đầu vào của lượt chạy (`inputs`)

Trên môi trường tích hợp dùng chung, dữ liệu thay đổi theo thời điểm và có người khác cùng dùng. Plan không nên ghi cứng mã tài khoản, mã lệnh hay ngày. Khai báo các giá trị này trong `inputs`. Mỗi input được phân giải **một lần trước mọi case** và dùng như biến `{{tên}}`.

Nguồn giá trị theo thứ tự ưu tiên:

| Thứ tự | Nguồn | Khai báo | Khi nào dùng |
|---|---|---|---|
| 1 | Người chạy điền | — | CLI `--input tên=giá-trị`; ô đầu vào trên bảng plan khi chạy thử |
| 2 | `fill` | Bước fixture, một bước phải `save` vào tên input | Cách lấy cố định: gọi API, INSERT, truy vấn dữ liệu có sẵn |
| 3 | `prepare` | Mô tả bằng lời, cùng `uses` (namespace được dùng) | Cách lấy cần suy luận: "tìm …, không có thì tạo …" |
| 4 | `default` | Giá trị, hỗ trợ `${env.TÊN}` | Giá trị thường dùng |

```yaml
inputs:
  symbol: { desc: Mã chứng khoán, default: FPT, require: { op: matches, value: '^[A-Z]{3}$' } }
  new_order:
    fill:
      - action: http_request
        args: { method: POST, url: '{{order-service.url}}/orders', body: { symbol: '{{symbol}}', side: BUY, qty: 100, price: 25000 } }
        save: { new_order: $.body.id }
    cleanup:                       # chạy sau mọi case, khi giá trị lấy bằng fill
      - { action: http_request, args: { method: POST, url: '{{order-service.url}}/orders/{{new_order}}/cancel' } }
  cancelled_order:
    prepare: Tìm lệnh CANCELLED của mã {{symbol}}; không có thì đặt lệnh mới rồi huỷ.
    uses: [db, http]
    require: { op: gt, value: 0 }
```

Xem đầy đủ tại `examples/plans/order-inputs.plan.yaml`.

**Agent chuẩn bị (`prepare`).** Một phiên agent riêng chuẩn bị các input có `prepare`, trước khi chạy case. Agent dùng tool trong `uses` và phải trả giá trị bằng `provide_input`, kèm evidence chứa giá trị đó. Agent không tự viết giá trị. Dữ liệu agent tạo mới được agent đăng ký dọn bằng `register_cleanup`. Agent chạy test của từng case vẫn không có quyền ghi.

**`require` và verdict `blocked`.** Input bắt buộc không có giá trị, hoặc giá trị không thoả `require`, làm lượt chạy bị chặn. Khi đó các case nhận `blocked` (🚧 "chưa đủ điều kiện") và không được chạy. Báo cáo ghi lý do. `blocked` khác `fail` (hệ thống sai) và `error` (lỗi khi chạy). Dùng `require` để kiểm tra điều kiện môi trường, ví dụ phiên giao dịch đang mở.

**Biến dựng sẵn**, cố định trong một lượt chạy và được ghi vào log:

| Biến | Giá trị |
|---|---|
| `{{$run.short}}` | 6 ký tự riêng cho lượt chạy; gắn vào dữ liệu tạo ra để lọc và dọn đúng dữ liệu của mình |
| `{{$run.id}}`, `{{$run.date}}`, `{{$run.time}}`, `{{$run.epoch}}` | Mã lượt chạy, ngày theo múi giờ máy, thời điểm bắt đầu |
| `{{$case.id}}` | Mã case đang chạy |

**Dọn dữ liệu.** Bước `cleanup` của input và bước agent đăng ký chạy sau mọi case, theo thứ tự ngược với lúc tạo. Các bước này chạy cả khi lượt chạy bị chặn. Lỗi khi dọn được ghi trong log, không đổi verdict. Trên môi trường dùng chung, không dọn theo điều kiện rộng như `DELETE … WHERE symbol = 'VNM'`; dọn theo mã vừa tạo.

Màn chi tiết lượt chạy hiển thị bảng đầu vào: giá trị, nguồn, evidence với input do agent chuẩn bị. Trang cũng liệt kê các lời gọi tool khi chuẩn bị và dọn.

## 7. Mẫu theo loại test

### 7.1. Test API

Xem `examples/plans/order.plan.yaml`. Đối chiếu cả phản hồi HTTP lẫn dữ liệu trong DB, vì API có thể trả đúng mã nhưng ghi sai dữ liệu.

### 7.2. Test integration có xử lý bất đồng bộ

Xem `examples/plans/order-integration.plan.yaml`. Hai công cụ dành riêng cho loại test này:

**`wait_until`**: chờ tới khi dữ liệu đạt trạng thái mong đợi. Viết bước như sau:

```yaml
- Dùng wait_until gọi lặp db_query cho tới khi bản ghi của lệnh có status FILLED, tối đa 20 giây.
```

Hết thời gian chờ không làm case lỗi. Agent vẫn assert với giá trị cuối cùng, và case nhận `fail` nếu giá trị đó sai. Thời gian chờ tối đa là 300 giây.

**Webhook**: nhận callback mà hệ thống của bạn gửi ra. Khai báo `webhook` trong `requires`, rồi viết bước:

```yaml
- Tạo một webhook để nhận callback.
- Gọi POST {{base_url}}/orders với ..., callback_url là URL webhook vừa tạo.
- Chờ webhook nhận được callback, tối đa 20 giây.
```

Khi hệ thống chạy trong Docker hoặc trên máy khác, đặt `publicBaseUrl` trong row `action-webhook` thành địa chỉ mà hệ thống gọi tới được, ví dụ `http://host.docker.internal:4500`. Đồng thời đặt `port` cố định tương ứng.

### 7.3. Test giao diện web (E2E)

Xem `examples/plans/order-ui.plan.yaml`. Chạy bằng `-c aitest.e2e.yml`.

```yaml
requires: [browser, db]
context: |
  Trang chủ có form "Đặt lệnh" gồm: Mã chứng khoán, Chiều, Khối lượng, Giá và nút "Đặt lệnh".
  Dùng browser_snapshot để đọc nội dung trang; kết quả snapshot là văn bản, assert với path `$`.
teardown:
  - action: browser_close
```

Lưu ý khi soạn:

- Gọi tên trường và nút **đúng như hiển thị trên giao diện**, kèm dấu ngoặc kép.
- Thêm bước "Chụp snapshot trang sau khi ..." trước khi kiểm tra giao diện.
- Expectation giao diện dùng `contains` hoặc `matches`, với chuỗi đặc trưng như "Đã đặt lệnh số", không phải chuỗi ngắn như "VCB". Chuỗi ngắn có thể khớp nhầm với nội dung ô nhập liệu.
- Luôn thêm ít nhất một expectation kiểm tra DB.
- Giữ `teardown: browser_close` để mỗi case bắt đầu với trình duyệt sạch.

### 7.4. Test sự kiện qua Kafka và RabbitMQ

Xem `examples/plans/order-events.plan.yaml`. Chạy bằng `-c aitest.events.yml`, hoặc thêm tool Kafka, RabbitMQ qua chat.

```bash
# Kafka và RabbitMQ chạy cục bộ bằng Docker
docker run -d --name aitest-kafka -p 9092:9092 apache/kafka:4.1.0
docker run -d --name aitest-rabbit -p 5672:5672 -p 15672:15672 rabbitmq:4-management
KAFKA_BROKERS=127.0.0.1:9092 RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 pnpm demo:api
pnpm aitest -c aitest.events.yml run examples/plans/order-events.plan.yaml
```

Lưu ý khi soạn:

- **Luôn lọc theo mã nghiệp vụ** vừa tạo (`$.value.orderId`), vì topic và exchange dùng chung với hệ thống khác và lượt chạy khác.
- **Kafka:** viết bước "Dùng kafka_wait_for trên topic …, lọc … , tối đa 20 giây". Mặc định agent đọc từ 2 phút trước, nên bước này đặt sau lời gọi API vẫn thấy bản tin.
- **RabbitMQ:** viết bước "Tạo tap RabbitMQ trên exchange … TRƯỚC khi gọi API". Bản tin phát ra trước khi có tap sẽ không được ghi nhận.
- Bản tin JSON được parse sẵn trong `value`; assert với path như `$.messages[0].value.status`, routing key ở `$.messages[0].routingKey`.
- Chờ quá thời gian thì kết quả có `satisfied: false` và case nhận `fail` ở expectation tương ứng, không nhận `error`.

## 8. Đọc kết quả

### 8.1. Verdict

| Verdict | Ý nghĩa | Việc cần làm |
|---|---|---|
| `pass` | Mọi expectation có assertion đạt | Không |
| `fail` | Có expectation không đạt | Xem cột "Thực tế" trong báo cáo: lỗi hệ thống hay plan đặt sai tiêu chí |
| `inconclusive` | Có expectation chưa được assert | Xem mục 9.1 |
| `error` | Setup lỗi, agent lỗi hoặc vượt thời gian | Xem dòng "Lý do" trong báo cáo |

### 8.2. Thư mục kết quả

Mỗi lượt chạy tạo thư mục `.aitest/runs/<thời điểm>-<mã plan>/`:

| File | Dành cho | Nội dung |
|---|---|---|
| `report.md` | Người đọc | Tổng hợp, expectation, giá trị thật, chuỗi action, tóm tắt của agent |
| `junit.xml` | CI | Định dạng JUnit chuẩn |
| `events.jsonl` | Tra cứu chi tiết | Mọi sự kiện theo thứ tự: prompt gửi agent, tool call, kết quả, assertion |

### 8.3. Đọc `report.md`

Bảng expectation của mỗi case có các cột:

| Cột | Ý nghĩa |
|---|---|
| Tiêu chí | Toán tử, giá trị mong đợi và nguồn (`plan` hoặc `agent`) |
| Thực tế | Giá trị aitest đọc được, mã evidence và path, ví dụ `201` tại ev1 `$.status` |
| Kết quả | ✅ hoặc ❌; ghi "(n lần thử)" nếu agent assert nhiều lần |

Luôn kiểm tra cột "Thực tế" của case `pass` quan trọng. Cột này cho biết agent đã đối chiếu đúng dữ liệu hay chưa. Ví dụ, path phải trỏ vào kết quả của lệnh gọi API, không phải một truy vấn khác.

Bảng "Chuỗi action" liệt kê theo thứ tự mọi action đã chạy, gồm cả fixture. Mã evidence (`ev1`, `ev2`...) dùng để đối chiếu với cột "Thực tế".

### 8.4. Quản lý plan và xem lượt chạy trên giao diện (trang Plan)

Trang **Plan** (`pnpm aitest -c aitest.web.yml serve`) gom plan và lượt chạy vào một nơi. Trang có hai tab: **Danh sách plan** và **Lượt chạy**.

**Danh sách plan.** Plan được nhóm theo thư mục. Viền trái của mỗi thẻ có màu theo kết quả lần chạy gần nhất: xanh là đạt hết, đỏ là có case chưa đạt, vàng là plan lỗi cú pháp.

| Thao tác | Cách làm |
|---|---|
| Tìm plan | Gõ tên, mã plan, mã hoặc tên case, đường dẫn |
| Lọc theo trạng thái | Chip "Chưa chạy", "Đạt hết", "Có case chưa đạt", "Plan lỗi", kèm số lượng |
| Xem lần chạy gần nhất | Bấm cột kết quả trên thẻ; lượt chạy thật được ưu tiên hơn lượt chạy thử |
| Chạy plan | "▶ Chạy" → chọn case, điền đầu vào (mục 6.1) → "▶ Chạy N case". Giao diện chuyển ngay sang màn theo dõi lượt chạy |
| Sửa cùng agent | Mở plan trong một cuộc chat mới (mục 5.6) |
| Soạn plan mới | "+ Soạn plan mới cùng agent" |

**Chi tiết plan.** Bấm một thẻ để xem chi tiết:

- Đường dẫn, namespace tool, hệ thống trong catalog, kết quả lần chạy gần nhất.
- Tab **Case**: bảng đầu vào (ghi rõ giá trị lấy từ đâu khi để trống), các case kèm kết quả lần chạy gần nhất; bấm case để xem bước và kết quả mong đợi.
- Tab **Lịch sử chạy**: mọi lượt chạy của plan này.
- Tab **Nội dung YAML**: nguyên văn plan và cảnh báo khi kiểm tra.

Plan chưa hợp lệ không chạy được; trang liệt kê lỗi và gợi ý "Sửa cùng agent". Giao diện cho chạy tối đa 2 lượt cùng lúc; cấu hình bằng `maxConcurrent` của row `plan-manager`.

**Xem một lượt chạy.** Tab **Lượt chạy** liệt kê mọi lượt chạy, gồm lượt chạy từ CLI, từ trang Plan và lượt chạy thử trong cuộc chat (nhãn "chạy thử"). Màn chi tiết lượt chạy agent đã làm gì và vì sao case ra kết quả đó, không cần mở file log. Lượt chạy đang diễn ra được cập nhật liên tục. Nút quay lại dẫn về plan của lượt chạy.

Chọn một lượt chạy rồi chọn case. Case không đạt được mở sẵn. Phần đầu case ghi model agent đã dùng.

| Tab | Dùng để |
|---|---|
| **Hành trình** | Theo từng bước của plan: agent gọi tool nào, **vì sao** (lý do agent tự khai báo), lấy được evidence nào, ghi chú của bước. Fixture hiển thị ở đầu và cuối, kèm `desc` trong plan |
| **Giải thích kết quả** | Với mỗi expectation: tiêu chí (hoặc công thức), giá trị mong đợi, **giá trị thật nền tảng đọc được** và đọc ở đâu (mã evidence và path), **vì sao agent lấy dữ liệu đó**, kết luận, các lần agent thử lại. Bấm mã evidence (`ev2`) để xem nguyên văn tham số agent gửi và kết quả action trả về |
| **Dòng thời gian** | Mọi việc theo thứ tự: fixture, prompt gửi agent, agent xin quyền, gọi tool, ghi chú từng bước, suy nghĩ và trả lời của agent, assertion, kết thúc case |
| **Prompt gửi agent** | Nguyên văn chỉ dẫn agent nhận được, để kiểm tra plan có diễn đạt đúng ý không |
| **Dữ liệu thô** | Từng event JSON, lọc theo loại; dùng khi cần điều tra sâu |

Cách đọc nhanh khi case có vấn đề:

| Hiện tượng trong tab Giải thích | Nguyên nhân thường gặp |
|---|---|
| Giá trị thật đúng với hệ thống nhưng khác mong đợi | Hệ thống có lỗi thật, hoặc tiêu chí trong plan sai |
| Giá trị thật `undefined` | Agent đọc sai path hoặc sai evidence; xem lại mô tả cấu trúc dữ liệu trong `context` |
| Evidence là kết quả của action không liên quan | Agent chọn nhầm dữ liệu để đối chiếu; mô tả expectation cụ thể hơn |
| Nhiều lần thử | Agent mò path; mô tả rõ dữ liệu cần đối chiếu |
| "Agent không assert expectation này" | Xem Dòng thời gian để biết agent dừng ở đâu |

Từ kết quả chạy thử trong cuộc chat, bấm "Xem log chi tiết" để mở thẳng lượt chạy đó.

**Lý do của từng lời gọi tool.** Kiro không gửi phần suy nghĩ ra ngoài, kể cả khi đặt `--effort high`. Vì vậy, nền tảng yêu cầu agent khai báo `reason` (lấy dữ liệu gì, để làm gì) và `step` (phục vụ bước nào) ở mỗi lần gọi tool. Lý do được ghi vào log, hiển thị ở tab Hành trình, Giải thích kết quả, và trên thẻ tool trong cuộc chat. Lời gọi thiếu lý do vẫn chạy, nhưng được đánh dấu "Agent không nêu lý do". Fixture lấy lý do từ trường `desc` trong plan.

### 8.5. Tra `events.jsonl`

Mỗi dòng là một sự kiện JSON. Các loại sự kiện hay dùng:

| `type` | Nội dung |
|---|---|
| `agent/prompt` | Toàn bộ chỉ dẫn gửi cho agent |
| `action/call` | Tên action, tham số, kết quả, pha (`setup`, `agent`, `teardown`) |
| `assert/result` | Expectation, evidence, path, giá trị thật, đạt hay không |
| `agent/update` | Tin nhắn và tool call của agent |
| `agent/permission` | Yêu cầu dùng tool của agent và quyết định cho phép hoặc từ chối |
| `case/end` | Verdict và lý do |

Lọc nhanh các assertion của một lượt chạy:

```bash
grep '"assert/result"' .aitest/runs/<id>/events.jsonl
```

## 9. Xử lý sự cố

### 9.1. Case `inconclusive`: "not asserted"

Agent không gọi assert cho một expectation. Nguyên nhân thường gặp:

- `desc` của expectation mơ hồ, agent không biết dữ liệu nào cần đối chiếu. Viết lại `desc` cụ thể hơn.
- Bước không tạo ra dữ liệu cần kiểm tra. Ví dụ, expectation về DB nhưng không có bước truy vấn DB.
- Agent dừng giữa chừng. Xem `stopReason` trong báo cáo hoặc sự kiện `case/end`.

### 9.2. Case `fail` nhưng hệ thống đúng

Xem cột "Thực tế":

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Thực tế là `undefined` | Path sai hoặc truy vấn không trả dòng nào | Mô tả rõ hơn cấu trúc dữ liệu trong `context` |
| Giá trị đúng nhưng khác kiểu, ví dụ `"true"` và `true` | Driver trả kiểu khác | Sửa `value` trong `check` cho khớp kiểu |
| Giá trị cũ | Kiểm tra trước khi xử lý bất đồng bộ hoàn tất | Thêm bước `wait_until` |
| Dữ liệu từ lượt chạy trước | Thiếu dọn dữ liệu | Thêm `setup` xoá dữ liệu cũ |

### 9.3. Case `error`

| Lý do trong báo cáo | Cách xử lý |
|---|---|
| `setup step N (...) failed: ...` | Sửa fixture; chạy thử câu SQL trực tiếp trên DB |
| `case timeout after ... ms` | Tăng `timeout` của case, hoặc rút bớt bước |
| `agent connection failed: cannot start kiro-cli` | Kiểm tra `kiro-cli` có trong PATH |
| `agent process exited ...` | Đăng nhập lại Kiro; xem stderr in kèm thông báo lỗi |
| `does not support MCP over HTTP` | Agent không phù hợp; dùng Kiro hoặc agent ACP hỗ trợ MCP HTTP |

### 9.4. Action bị từ chối (`denied`)

Guard chặn action. Ví dụ, câu lệnh ghi (`DELETE`, `UPDATE`) qua `db_query`. Đây là hành vi mong muốn: agent không được sửa dữ liệu. Muốn chuẩn bị dữ liệu thì dùng `setup` với `dbadmin_query`.

### 9.5. Lỗi trình duyệt

| Thông báo | Cách xử lý |
|---|---|
| `Browser "chrome-for-testing" is not installed` | Dùng Chrome: `AITEST_BROWSER=chrome`, hoặc cài trình duyệt bằng `npx @playwright/mcp install-browser chrome-for-testing` |
| Agent không tìm thấy nút hoặc trường | Ghi tên trong bước đúng như hiển thị trên giao diện |
| Thư mục `.playwright-mcp/` xuất hiện | File tạm của Playwright; có thể xoá |

### 9.6. Lỗi khi soạn plan cùng AI

| Hiện tượng | Cách xử lý |
|---|---|
| Trang báo "web client is not built" | Chạy `pnpm web:build` |
| Gửi tin nhắn báo "agent is still working" | Chờ agent xong lượt hiện tại, hoặc bấm "Dừng" |
| Agent dừng với lỗi `agent process exited` | Kiểm tra đăng nhập Kiro; tin nhắn tiếp theo tự kết nối lại |
| `validate_plan` báo `namespace dbadmin is fixture-only` | Bỏ `dbadmin` khỏi `requires`; fixture vẫn dùng được `dbadmin_query` |
| Thêm MCP server báo lỗi kết nối | Chạy thử lệnh trong terminal; kiểm tra đường dẫn lệnh và tham số; với HTTP kiểm tra URL kết thúc bằng `/mcp` |
| Plugin ở trạng thái "Chờ service" | Plugin cần một service chưa có, ví dụ plugin bị tắt; bật plugin cung cấp service đó |
| Muốn huỷ mọi thay đổi trên trang Plugin | Dừng Host, xoá `aitest.web.patch.yml`, khởi động lại |
| Agent báo `environment variables not set` khi đề xuất tool | Đặt biến môi trường được nêu, khởi động lại Host, nhắn agent đề xuất lại |
| Agent báo `param … is secret` | Agent đã định ghi giá trị bí mật vào cấu hình; nhắc agent dùng dạng `${env.TÊN}` |
| Đề xuất tool báo `already installed` | Tool đã có; nếu đang tắt, bật trên trang Plugin |
| `validate` báo `unknown system` | Kiểm tra `systems/<id>/service.yml` tồn tại và `id` trùng tên thư mục; lỗi đọc file được ghi trong thông báo |
| Biến `{{order-service.url}}` không được thay khi chạy | Môi trường hiện tại (`AITEST_ENV`) thiếu URL của hệ thống; xem event `systems/resolved` trong `events.jsonl` |
| `kafka_wait_for` trả `satisfied: false` dù hệ thống đã phát sự kiện | Kiểm tra tên topic bằng `kafka_list_topics` và điều kiện `match`; tăng `since` nếu bước chờ nằm xa lời gọi API |
| `rabbitmq_wait_for` không nhận bản tin | Tap phải được tạo trước khi gọi API; kiểm tra routing key (`order.*` khớp một từ, `order.#` khớp nhiều từ) |

## 10. Thực hành tốt

1. **Mỗi case một mục tiêu.** Case ngắn dễ đọc báo cáo và ít khi bị agent làm sai.
2. **Luôn dùng `check`.** Chỉ bỏ `check` khi tiêu chí không biểu diễn được bằng một giá trị.
3. **Đối chiếu chéo.** Kiểm tra cả phản hồi API, giao diện lẫn dữ liệu trong DB.
4. **Dữ liệu độc lập.** Mỗi case tự chuẩn bị và dọn dữ liệu, không dựa vào case trước.
5. **Mô tả dữ liệu trong `context`.** Tên bảng, tên cột và giá trị trạng thái giúp agent truy vấn đúng ngay lần đầu.
6. **Chạy `validate` trước `run`.** Lỗi plan được phát hiện trong một giây, không tốn lượt chạy của AI.
7. **Đọc báo cáo của case `pass` quan trọng.** Kiểm tra cột "Thực tế" để chắc chắn agent đối chiếu đúng dữ liệu.
8. **Chế độ nghiêm ngặt cho CI.** Đặt `allowRetry: false` trong row `verdict` để chỉ tính lần assert đầu tiên.

## Thuật ngữ mới

| Thuật ngữ | Nhóm | Ghi chú |
|---|---|---|
| namespace | A | Nhóm action, dùng trong `requires` |
| guard | A | Thành phần chặn action không được phép |
| topic, exchange, routing key | A | Khái niệm của Kafka và RabbitMQ |
| tap | A | Queue tạm để quan sát bản tin RabbitMQ mà không lấy mất bản tin của consumer thật |
| danh mục tool | B | Các tool đã kiểm duyệt mà agent được đề xuất thêm |
| catalog hệ thống | B | Mô tả các service dưới kiểm thử trong `systems/` |
| operation | A | Một cặp method + path của API, định danh bằng `operationId` |
| consumer | A | Thành phần đọc bản tin từ broker và xử lý |
