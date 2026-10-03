---
name: formula-expectations
description: Viết expectation có giá trị mong đợi phải tính (phí, tổng tiền, tổng hợp nhiều dòng, cộng dồn, số dư, làm tròn). Dùng khi kết quả cần kiểm tra là con số suy ra từ dữ liệu, không phải hằng số.
---

# Expectation dạng công thức

1. Không tự tính ra số. Viết công thức trong `check.expr`; nền tảng tính trên BigDecimal từ dữ liệu thật lúc chạy.
   Biến của công thức có hai nguồn:
   - `vars` của plan, đầu vào (`inputs`), giá trị `save` của bước chuẩn bị: nền tảng tự gắn, dùng thẳng tên kể cả trường lồng
     (`account_data.balance`). Không cần và không nên yêu cầu agent chạy test ánh xạ các biến này sang evidence.
   - Tên khác (`qty`, `price`): agent chạy test chỉ ra evidence và path khi assert; plan phải có bước đọc dữ liệu nêu rõ bảng hoặc trường chứa nó.
2. Tìm công thức có sẵn của service trong `get_system_context` (mục "Công thức"), ví dụ `fee(o)`, `summary(orders)`. Dùng lại thay vì viết lại.
3. Dữ liệu nhiều dòng: biến là cả bảng (`$.rows`) hoặc một cột (`$.rows[*].qty`); dùng `sum`, `filter`, `groupBy`, `cumsum`, `scan`.
4. Công thức dài: chia thành bước có tên trong `check.let`, báo cáo ghi giá trị từng bước.
5. Làm tròn luôn tường minh theo đặc tả: `round(x, 2, HALF_UP)`; chia không hết dùng `div(a, b, scale, MODE)`.
6. Kết quả dạng danh sách (ví dụ vị thế sau từng lệnh) được so từng phần tử với cột tương ứng (`$.body[*].position`).
7. Sau `validate_plan`, đọc `summary.formulas`: biến ở `fromRun` được tự gắn, biến ở `fromEvidence` cần bước thu thập.
   Sửa hết lỗi sai tên trường và cảnh báo "no step mentions" trước khi chạy thử.
8. Thử công thức bằng tool `calc` trước khi đưa vào plan (biến của lượt chạy không cần truyền). Công thức có `: ` trong YAML đặt trong dấu nháy kép hoặc khối `|`.

Plan mẫu: `examples/plans/order-formulas.plan.yaml`; công thức của service: `systems/order-service/formulas.yml`.
