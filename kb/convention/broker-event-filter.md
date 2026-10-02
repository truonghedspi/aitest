---
id: broker-event-filter
type: convention
title: Kiểm tra sự kiện broker luôn lọc theo mã nghiệp vụ vừa tạo
feature: events
source: user
created: 2026-10-02
updated: 2026-10-02
---

Topic Kafka và exchange RabbitMQ dùng chung với hệ thống khác và lượt chạy khác. Bước chờ sự kiện phải lọc bằng `match` theo mã nghiệp vụ vừa tạo, ví dụ `$.value.orderId`.

Với RabbitMQ, bước tạo tap đứng trước bước gọi API. Với Kafka, bước `kafka_wait_for` đứng sau bước gọi API.
