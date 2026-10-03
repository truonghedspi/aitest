---
title: Luồng khớp lệnh và callback
description: Lệnh có callback_url được khớp bất đồng bộ rồi gửi callback; dùng cho plan kiểm tra khớp lệnh, webhook, sự kiện order.filled.
systems: [order-service]
features: [order]
---

# Luồng khớp lệnh và callback

1. Lệnh đặt kèm `callback_url` được nhận với trạng thái `NEW`.
2. Khoảng 1,5 giây sau, consumer `order-executor` khớp toàn bộ lệnh: `status` chuyển `FILLED`, `filled_qty` bằng `qty`, ghi `filled_at`.
3. Order API gửi `POST` tới `callback_url`, header `x-event-type: order.filled`, body
   `{"event": "order.filled", "orderId": <id>, "status": "FILLED", "filledQty": <qty>}`.
4. Sự kiện `order.filled` được phát lên `order-events` (Kafka) và `order-exchange` (RabbitMQ).

Lưu ý khi kiểm tra:

- Khớp lệnh là bất đồng bộ: chờ bằng `webhook_wait` hoặc `wait_until`, không đọc trạng thái ngay sau khi đặt lệnh.
- Lệnh không có `callback_url` giữ trạng thái `NEW` cho tới khi bị huỷ.
