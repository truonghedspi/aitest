# Đặc tả nghiệp vụ Order API

Tài liệu yêu cầu của ứng dụng mẫu. Agent soạn plan đọc tài liệu này qua nguồn context `order-spec`.

## 1. Đặt lệnh

`POST /orders` với body JSON:

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `symbol` | chuỗi | Đúng 3 chữ cái in hoa, ví dụ `VNM` |
| `side` | chuỗi | `BUY` hoặc `SELL` |
| `qty` | số nguyên | Lớn hơn 0 và là bội số của 100 (lô chẵn) |
| `price` | số nguyên | Lớn hơn 0, đơn vị đồng |
| `callback_url` | chuỗi, tuỳ chọn | URL http(s) nhận thông báo khi lệnh khớp |

- Lệnh hợp lệ: HTTP 201, body là bản ghi lệnh với `status` = `NEW`.
- Lệnh vi phạm bất kỳ ràng buộc nào: HTTP 400, body `{"error": "<lý do>"}`, không lưu bản ghi.

### Phí giao dịch

Mọi bản ghi lệnh trả về qua API có trường `fee`: phí giao dịch tính bằng **nghìn đồng**.

`fee = 0,15% × qty × price / 1000`, làm tròn **nửa lên** tới **2 chữ số thập phân**.

Ví dụ: qty 100, price 70.000 → 10,5; qty 100, price 10.300 → 1,545 → **1,55**.

Phí không lưu trong bảng `orders`; API tính khi trả bản ghi.

## 2. Tra cứu lệnh

- `GET /orders/{id}`: HTTP 200 kèm bản ghi; không tồn tại thì HTTP 404.
- `GET /orders`: 50 lệnh mới nhất.

### Tổng hợp theo mã

`GET /orders/summary?symbol=<mã>`: tổng hợp các lệnh của mã, **bỏ lệnh đã huỷ**:

| Trường | Ý nghĩa |
|---|---|
| `orders` | Số lệnh |
| `buyQty`, `sellQty` | Tổng khối lượng mua, bán |
| `buyValue`, `sellValue` | Tổng `qty × price` của lệnh mua, bán (đồng) |
| `totalFee` | Tổng phí của từng lệnh (nghìn đồng), mỗi lệnh tính phí như mục 1 rồi mới cộng |
| `netCash` | `sellValue − buyValue − totalFee × 1000` (đồng) |

`GET /orders/positions?symbol=<mã>`: danh sách theo thứ tự lệnh (bỏ lệnh đã huỷ), mỗi phần tử `{id, side, qty, position}`; `position` là vị thế cộng dồn sau lệnh đó: lệnh mua cộng `qty`, lệnh bán trừ `qty`.

## 3. Huỷ lệnh

`POST /orders/{id}/cancel`:

- Chỉ lệnh ở trạng thái `NEW` được huỷ: HTTP 200, `status` chuyển sang `CANCELLED`, ghi `cancelled_at`.
- Lệnh ở trạng thái khác (`FILLED`, `CANCELLED`): HTTP 409, trạng thái giữ nguyên.
- Lệnh không tồn tại: HTTP 404.

## 4. Khớp lệnh

- Lệnh có `callback_url` được khớp toàn bộ sau khoảng 1,5 giây: `status` = `FILLED`, `filled_qty` = `qty`, ghi `filled_at`.
- Sau khi khớp, hệ thống gửi `POST` tới `callback_url` với header `x-event-type: order.filled` và body
  `{"event": "order.filled", "orderId": <id>, "status": "FILLED", "filledQty": <qty>}`.
- Lệnh không có `callback_url` giữ trạng thái `NEW` cho tới khi bị huỷ.

## 5. Giao diện web

Trang `/` gồm form "Đặt lệnh" (Mã chứng khoán, Chiều, Khối lượng, Giá, nút "Đặt lệnh"), vùng thông báo và bảng "Lệnh gần đây".
Đặt lệnh thành công hiển thị "Đã đặt lệnh số <id>"; thất bại hiển thị "Lỗi: <lý do>".

## 6. Dữ liệu

Bảng `orders`: `id`, `symbol`, `side`, `qty`, `price`, `status`, `created_at`, `cancelled_at`, `filled_qty`, `filled_at`, `callback_url`.
