---
title: Quy ước soạn plan của nhóm
description: Quy ước bắt buộc khi soạn plan cho mọi hệ thống; luôn có trong hướng dẫn của agent.
inclusion: always
---

- Mã plan dạng `TP-<HỆ-THỐNG>-<TÍNH-NĂNG>-<số>`, mã case viết tắt tính năng kèm số: `CAN-01`.
- Mỗi case kiểm tra một hành vi; đối chiếu cả response API lẫn dữ liệu trong DB.
- Dữ liệu tạo ra trên môi trường dùng chung gắn mã lượt chạy `{{$run.short}}` và được dọn sau lượt chạy.
