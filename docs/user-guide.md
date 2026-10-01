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
| Kiro CLI | Đã đăng nhập | `kiro-cli acp --help` |
| Google Chrome | Chỉ cần cho test giao diện | Có trong thư mục Applications |

### 2.2. Cài đặt

```bash
pnpm install
pnpm test        # khoảng 10 giây, không gọi AI; mọi bài test phải đạt
```

### 2.3. File cấu hình

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
| `pnpm aitest actions` | Liệt kê action agent có thể dùng |
| `pnpm aitest report <events.jsonl>` | Dựng lại báo cáo từ run log |
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

Mỗi expectation chỉ nên kiểm tra **một giá trị**. Ví dụ, tách "status là NEW và qty là 100" thành hai expectation.

### 5.5. Kiểm tra trước khi chạy

```bash
pnpm aitest validate examples/plans/order.plan.yaml
```

Lệnh báo lỗi khi YAML sai cú pháp, thiếu trường bắt buộc, trùng mã case hoặc mã expectation. Lệnh cũng cảnh báo khi `requires` chứa namespace chưa có action nào đăng ký.

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

### 8.4. Tra `events.jsonl`

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
