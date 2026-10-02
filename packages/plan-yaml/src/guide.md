## Định dạng plan YAML (`*.plan.yaml`)

```yaml
id: TP-ORDER-CANCEL            # mã plan, duy nhất trong dự án
name: Huỷ lệnh qua Order API
description: Một câu nêu mục tiêu của plan.
requires: [http, db]           # namespace action mà agent chạy test được dùng
vars:
  base_url: ${env.ORDER_API_URL:-http://127.0.0.1:4100}
context: |
  Bối cảnh nghiệp vụ cho agent chạy test: tên bảng, cột, giá trị trạng thái, quy tắc.
setup:                         # chạy trước MỖI case, không qua AI
  - desc: Xoá dữ liệu cũ
    action: dbadmin_query
    args: { sql: "DELETE FROM orders WHERE symbol = 'MWG'" }
cases:
  - id: TC-01
    title: Huỷ lệnh NEW thành công
    timeout: 180               # giây, tuỳ chọn
    setup:                     # chạy sau setup của plan
      - action: dbadmin_query
        args: { sql: "INSERT INTO orders (...) VALUES (...) RETURNING id" }
        save: { order_id: '$.rows[0].id' }
    steps:
      - Gọi POST {{base_url}}/orders/{{order_id}}/cancel.
      - Truy vấn bảng orders theo id {{order_id}}.
    expect:
      - id: http-200
        desc: API trả về HTTP 200
        check: { op: eq, value: 200 }
      - id: db-cancelled
        desc: Bản ghi trong DB có status CANCELLED
        check: { op: eq, value: CANCELLED }
    teardown:
      - action: dbadmin_query
        args: { sql: "DELETE FROM orders WHERE id = ?", params: ["{{order_id}}"] }
```

### Quy tắc viết bước (`steps`)

- Mỗi bước một hành động, theo đúng thứ tự thực hiện.
- Ghi rõ phương thức, URL, body; bảng và điều kiện truy vấn; tên trường và nút giao diện đúng như hiển thị.
- Nói rõ dữ liệu cần lấy cho bước sau, ví dụ "Lấy id lệnh từ response".
- Biến `{{tên}}` lấy từ `vars` hoặc từ `save` của fixture.

### Quy tắc viết expectation

- Mỗi expectation kiểm tra **một** giá trị; `id` ngắn, dạng `http-201`, `db-status`.
- Luôn có `check` khi tiêu chí biểu diễn được bằng một giá trị. Toán tử: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
  `contains`, `matches` (biểu thức chính quy), `exists`, `not_exists` (hai toán tử cuối không cần `value`).
- `eq` coi số và chuỗi số là bằng nhau (`100` và `"100"`).
- Đối chiếu chéo: kiểm tra cả phản hồi API (hoặc giao diện) lẫn dữ liệu trong DB.
- Expectation giao diện dùng `contains` với chuỗi đặc trưng đủ dài, không dùng chuỗi ngắn dễ khớp nhầm.

### Giá trị mong đợi phải tính toán

Khi giá trị mong đợi phụ thuộc dữ liệu lúc chạy (phí, tổng tiền, giá trần), dùng `expr` thay cho `value`:

```yaml
- id: fee-correct
  desc: Phí trong response đúng công thức
  check: { op: eq, expr: "round(qty * price / 1000 * 0.0015, 2, HALF_UP)" }
```

- Plan cố định công thức; agent chạy test chỉ chỉ ra evidence chứa từng biến; nền tảng tính trên BigDecimal.
- `op` phải là `eq`, `ne`, `gt`, `gte`, `lt`, `lte`. Không dùng cùng lúc `value` và `expr`.
- `+ - * %` chính xác, giữ đủ phần thập phân. `/` chỉ dùng khi chia hết; chia không hết dùng `div(a, b, scale, MODE)`.
- **Không có làm tròn mặc định.** Làm tròn ghi rõ cách làm tròn theo đặc tả của tính năng:
  `round(x, scale, MODE)` (scale âm: hàng chục, trăm), `roundStep(x, step, MODE)` (bước giá, lô), `roundSig(x, digits, MODE)`,
  `floor/ceil/trunc(x, scale)`, `div(a, b, scale, MODE)`, `sqrt(x, scale, MODE)`.
- MODE: `UP`, `DOWN`, `CEILING`, `FLOOR`, `HALF_UP`, `HALF_DOWN`, `HALF_EVEN` (làm tròn ngân hàng), `UNNECESSARY` (báo lỗi nếu cần làm tròn).
- Hàm khác: `abs`, `min`, `max`, `sum`, `avg` (chính xác hoặc báo lỗi), `pct(x, p)`.
- Viết công thức đúng như đặc tả, kể cả quy tắc làm tròn; không tính sẵn ra số.
- Cần thử một phép tính khi soạn plan: dùng tool `calc` hoặc `round_number`, không tự tính nhẩm.

### Fixture (`setup`, `teardown`)

- Thứ tự: `setup` của plan → `setup` của case → agent → `teardown` của case → `teardown` của plan.
- Fixture gọi được mọi action, kể cả kết nối ghi DB (`dbadmin_query`) mà agent chạy test không thấy.
- Mỗi case phải tự chuẩn bị dữ liệu, không dựa vào case trước. Dọn dữ liệu đã tạo trong `teardown`.

### Đầu vào (`inputs`) và dữ liệu trên môi trường dùng chung

Môi trường tích hợp dùng chung với người khác và thay đổi theo thời điểm, nên plan không ghi cứng mã tài khoản, mã lệnh, ngày.

- Giá trị thay đổi theo lượt chạy khai báo trong `inputs`; dùng như biến `{{tên}}`. Nguồn theo thứ tự: người chạy điền → `fill` → `prepare` → `default`.
- `fill`: bước xác định (gọi API, INSERT bằng `dbadmin_query`, truy vấn dữ liệu có sẵn); một bước phải `save` vào tên input. `cleanup` dọn dữ liệu do `fill` tạo.
- `prepare`: mô tả bằng lời khi cách lấy cần suy luận, ví dụ "tìm tài khoản đủ số dư, không có thì tạo mới". Agent chuẩn bị thực hiện và tự đăng ký bước dọn. Khai báo `uses` là namespace agent được dùng.
- `require`: điều kiện giá trị phải thoả (`op`, `value` như `check`). Không thoả thì lượt chạy bị chặn (`blocked`), case không chạy và không bị tính là lỗi hệ thống.
- Biến dựng sẵn: `{{$run.short}}` (6 ký tự, riêng cho mỗi lượt chạy), `{{$run.id}}`, `{{$run.date}}`, `{{$run.time}}`, `{{$case.id}}`. Gắn `$run.short` vào dữ liệu tạo ra (mã tham chiếu, ghi chú) để lọc và dọn đúng dữ liệu của lượt chạy.
- Không dọn theo điều kiện rộng như `DELETE ... WHERE symbol = 'VNM'`: câu này xoá cả dữ liệu của người khác. Dọn theo mã vừa tạo hoặc theo `$run.short`.

```yaml
inputs:
  account:
    desc: Tài khoản có số dư từ 100 triệu
    prepare: Tìm tài khoản đang hoạt động có balance >= 100000000 trong bảng accounts; không có thì tạo mới qua POST /accounts.
    uses: [db, http]
    require: { op: exists }
  order_id:
    fill:
      - action: http_request
        args: { method: POST, url: '{{base_url}}/orders', body: { symbol: FPT, side: BUY, qty: 100, price: 1000, note: 'ait-{{$run.short}}' } }
        save: { order_id: $.body.id }
    cleanup:
      - { action: http_request, args: { method: POST, url: '{{base_url}}/orders/{{order_id}}/cancel' } }
```

### Xử lý bất đồng bộ và callback

- Trạng thái thay đổi sau một khoảng trễ: viết bước "Dùng wait_until gọi lặp db_query cho tới khi ..., tối đa N giây".
- Hệ thống gửi callback ra ngoài: khai báo `webhook` trong `requires`, viết bước tạo webhook, truyền URL cho hệ thống,
  rồi chờ webhook nhận callback.
