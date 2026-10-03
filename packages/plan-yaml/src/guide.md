## Định dạng plan YAML (`*.plan.yaml`)

```yaml
id: TP-ORDER-CANCEL            # mã plan, duy nhất trong dự án
name: Huỷ lệnh qua Order API
description: Một câu nêu mục tiêu của plan.
requires: [http, db]           # namespace action mà agent chạy test được dùng
vars:
  base_url: ${env.ORDER_API_URL:-http://127.0.0.1:4100}
systems: [order-service]       # agent chạy test nhận bảng, cột, giá trị, quy tắc từ catalog của hệ thống
contextRefs: [context/order/matching-flow.md]   # tài liệu nghiệp vụ dùng chung, tuỳ chọn
context: |
  Chỉ điều riêng của plan này, ví dụ dữ liệu dùng riêng hay lưu ý cho các case.
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

### Bối cảnh cho agent chạy test

Mỗi sự thật chỉ ghi ở một nơi:

- Bảng, cột, giá trị hợp lệ, quy tắc nghiệp vụ của một hệ thống: catalog hệ thống, qua `systems`. Thiếu thì đề xuất bằng `propose_system_knowledge`.
- Quy trình nghiệp vụ dài dùng cho nhiều plan: tài liệu trong thư mục ngữ cảnh, qua `contextRefs`. Chưa có thì đề xuất bằng `propose_context_doc`.
- `context`: chỉ điều riêng của plan. `validate_plan` cảnh báo khi `context` chép lại điều catalog đã có.

### Quy tắc viết bước (`steps`)

- Mỗi bước một hành động, theo đúng thứ tự thực hiện.
- Ghi rõ phương thức, URL, body; bảng và điều kiện truy vấn; tên trường và nút giao diện đúng như hiển thị.
- Nói rõ dữ liệu cần lấy cho bước sau, ví dụ "Lấy id lệnh từ response".
- Biến `{{tên}}` lấy từ `vars` hoặc từ `save` của fixture.
- Bước gọi API của hệ thống trong catalog nên viết dạng có cấu trúc. `validate_plan` kiểm tra dạng này theo OpenAPI:
  operation có thật, đủ tham số path và query bắt buộc, body đúng schema (sai schema chỉ là cảnh báo, vì case kiểm tra lỗi gửi body sai cố ý).

```yaml
steps:
  - call: order-service.cancelOrder       # <system>.<operationId>
    path: { id: "{{order_id}}" }
    desc: huỷ lệnh vừa đặt
  - call: order-service.getSummary
    query: { symbol: FPT }
  - Đọc bảng orders theo id {{order_id}}.  # bước dạng câu vẫn dùng được, trộn trong cùng danh sách
```

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

- Plan cố định công thức; nền tảng tính trên BigDecimal từ giá trị thật. Biến của công thức có hai nguồn:

| Biến là | Ai gắn giá trị | Viết trong công thức |
|---|---|---|
| `vars` của plan, đầu vào (`inputs`), giá trị `save` của bước chuẩn bị | Nền tảng tự gắn lúc assert | Dùng thẳng tên, kể cả trường lồng: `account_data.balance`; trong bước dùng `{{account_data.id}}` |
| Giá trị agent chạy test đọc được (response API, dòng DB) | Agent chỉ ra evidence và path khi assert | Tên tự đặt, ví dụ `qty`; phải có bước lấy dữ liệu nêu rõ bảng hoặc trường chứa nó |

```yaml
inputs:
  account_data:
    desc: Tài khoản tạo riêng cho lượt chạy
    fill:
      - action: http_request
        args: { method: POST, url: "{{core.url}}/accounts", body: { type: NORMAL } }
        save: { account_data: $.body }        # giá trị là object; công thức đọc được account_data.balance
cases:
  - steps:
      - Gọi GET {{core.url}}/accounts/{{account_data.id}}/balance; lấy available từ response.
    expect:
      - id: available
        desc: Số dư khả dụng trong response bằng số dư trừ phần phong toả của tài khoản
        # Giá trị thực tế: agent assert bằng evidenceId + path của trường available ở bước trên.
        # Giá trị mong đợi: công thức chỉ dùng account_data, nền tảng tự gắn; không cần `inputs`.
        check: { op: eq, expr: "account_data.balance - account_data.blocked" }
```

- Không đặt giá trị cần đối chiếu vào biến chỉ để công thức "thấy" được; giá trị thực tế luôn do agent chạy test lấy từ hệ thống.
- `validate_plan` trả `summary.formulas`: biến nền tảng tự gắn (`fromRun`) và biến cần evidence (`fromEvidence`) của từng công thức;
  công thức chỉ dùng biến có sẵn trong plan được tính thử ngay. Đọc phần này trước khi chạy thử.
- `op` phải là `eq`, `ne`, `gt`, `gte`, `lt`, `lte`. Không dùng cùng lúc `value` và `expr`.
- `+ - * %` chính xác, giữ đủ phần thập phân. `/` chỉ dùng khi chia hết; chia không hết dùng `div(a, b, scale, MODE)`.
- **Không có làm tròn mặc định.** Làm tròn ghi rõ cách làm tròn theo đặc tả của tính năng:
  `round(x, scale, MODE)` (scale âm: hàng chục, trăm), `roundStep(x, step, MODE)` (bước giá, lô), `roundSig(x, digits, MODE)`,
  `floor/ceil/trunc(x, scale)`, `div(a, b, scale, MODE)`, `sqrt(x, scale, MODE)`.
- MODE: `UP`, `DOWN`, `CEILING`, `FLOOR`, `HALF_UP`, `HALF_DOWN`, `HALF_EVEN` (làm tròn ngân hàng), `UNNECESSARY` (báo lỗi nếu cần làm tròn).
- Hàm khác: `abs`, `min`, `max`, `sum`, `avg` (chính xác hoặc báo lỗi), `pct(x, p)`.
- Viết công thức đúng như đặc tả, kể cả quy tắc làm tròn; không tính sẵn ra số.
- Cần thử một phép tính khi soạn plan: dùng tool `calc` hoặc `round_number`, không tự tính nhẩm.

### Công thức phức tạp trên dữ liệu nhiều dòng

Biến của công thức có thể là cả bảng (`$.rows`, mỗi dòng là một bản ghi) hoặc một cột (`$.rows[*].qty`).
Ngôn ngữ biểu thức có:

- trường `r.qty`, chỉ số `xs[0]` / `xs[-1]`, danh sách `[a, b]`, bản ghi `{ total: a, fee: b }`, chuỗi `'BUY'`, `true`, `false`, `null`;
- so sánh `== != < <= > >=`, `and` `or` `not`, `c ? a : b`, `if(c, a, b)`, `coalesce(a, b)`;
- hàm ẩn danh `r -> r.qty * r.price`, `(acc, r) -> acc + r.amount`;
- trên danh sách: `sum`, `count`, `avg`, `min`, `max` (nhận danh sách và hàm chiếu), `map`, `filter`, `find`, `any`, `all`,
  `reduce`, `cumsum` (cộng dồn), `scan` (giữ giá trị sau từng phần tử, ví dụ số dư), `sortBy`, `groupBy` (trả `{ key, items }`),
  `distinct`, `first`, `last`, `len`.

Chia công thức dài thành bước có tên bằng `let`; báo cáo ghi giá trị từng bước:

```yaml
- id: net-cash
  desc: Tiền ròng của các lệnh khớp
  check:
    op: eq
    let:
      rows: "filter(orders, o -> o.status == 'FILLED')"
      gross: "sum(rows, o -> o.side == 'SELL' ? o.qty * o.price : -(o.qty * o.price))"
      fees: sum(rows, o -> fee(o)) * 1000
    expr: gross - fees
```

- Kết quả là danh sách (ví dụ vị thế cộng dồn) được so từng phần tử với cột tương ứng, ví dụ path `$.body[*].position`.
- **Công thức nghiệp vụ dùng lại** (phí, thuế, tổng hợp) đặt ở `formulas` của plan hoặc `systems/<id>/formulas.yml` của service,
  có `examples` lấy từ đặc tả; gọi như hàm: `fee(o)`, `summary(orders).netCash`. Xem bằng `describe_system`.
- Công thức của service chỉ thấy tham số của nó, không đọc biến bên ngoài.
- **YAML:** biểu thức có `: ` (toán tử `? :`) hoặc bắt đầu bằng `{`, `[`, `'` phải đặt trong dấu nháy kép hoặc khối `|`.

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

### Môi trường

- Plan chạy trên nhiều môi trường; địa chỉ, DB, topic khác nhau do `envs/<tên>.yml` quyết định. Không ghi cứng địa chỉ theo một môi trường.
- Dùng `{{<system>.url}}` của catalog hoặc biến trong `vars` (giá trị là mặc định, môi trường ghi đè được).
- Chỉ khai báo `envs: [..]` khi plan thật sự chỉ được chạy trên vài môi trường, ví dụ plan tạo nhiều dữ liệu không chạy trên UAT.

### Xử lý bất đồng bộ và callback

- Trạng thái thay đổi sau một khoảng trễ: viết bước "Dùng wait_until gọi lặp db_query cho tới khi ..., tối đa N giây".
- Hệ thống gửi callback ra ngoài: khai báo `webhook` trong `requires`, viết bước tạo webhook, truyền URL cho hệ thống,
  rồi chờ webhook nhận callback.
