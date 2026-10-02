---
id: order-callback-delay
type: lesson
title: Lệnh có callback được khớp sau khoảng 1,5 giây
feature: order
source: user
created: 2026-10-01
updated: 2026-10-01
---

Order API khớp lệnh bất đồng bộ. Kiểm tra trạng thái `FILLED` ngay sau khi đặt lệnh luôn thấy `NEW`.

Cách viết bước: tạo webhook, chờ webhook nhận callback, rồi dùng `wait_until` gọi lặp `db_query` tới khi `status = FILLED`, tối đa 20 giây.
