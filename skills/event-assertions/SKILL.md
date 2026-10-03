---
name: event-assertions
description: Soạn case kiểm tra hệ thống phát sự kiện ra Kafka hoặc RabbitMQ (đúng loại sự kiện, đúng nội dung, đủ số bản tin). Dùng khi yêu cầu nhắc tới sự kiện, topic, exchange, message, consumer.
metadata:
  systems: order-service
---

# Kiểm tra sự kiện qua message broker

1. `get_system_context`: xem mục "Kênh sự kiện" để biết topic hoặc exchange, tool namespace cần có, path lọc (`correlation`).
   Kênh báo thiếu tool thì đề xuất thêm từ danh mục (`list_tool_catalog`, `propose_tool`) trước khi viết plan.
2. Khai báo namespace của kênh trong `requires` và hệ thống trong `systems`.
3. **RabbitMQ:** bước tạo tap đứng TRƯỚC bước gọi API; bản tin phát trước khi có tap không được ghi nhận.
   **Kafka:** bước chờ đứng SAU bước gọi API; mặc định đọc từ 2 phút trước.
4. Luôn lọc bản tin theo mã nghiệp vụ vừa tạo (path `correlation`), vì topic dùng chung với lượt chạy khác.
5. Expectation trên evidence của bước chờ: `$.messages[0].value.<trường>`, routing key ở `$.messages[0].routingKey`.
   Chờ quá thời gian cho `satisfied: false` và case `fail`, không phải `error`.

Plan mẫu đầy đủ: `examples/plans/order-events.plan.yaml` (đọc bằng `read_plan`).
