---
id: event-correlation-unique
type: lesson
title: Mã lọc bản tin phải duy nhất giữa các lượt chạy
feature: events
source: user
created: 2026-10-02
updated: 2026-10-02
---

Order API mẫu cấp lại mã lệnh từ 1 khi DB được tạo mới, trong khi topic Kafka vẫn giữ bản tin của lượt chạy trước. Lọc chỉ theo `orderId` có thể khớp nhầm bản tin cũ.

Cách viết bước: lọc thêm theo trường khác của lệnh vừa tạo (symbol, qty), hoặc giới hạn `since` sát thời điểm gọi API.
