---
id: fixture-cleanup
type: convention
title: Mỗi case tự chuẩn bị và dọn dữ liệu
source: user
created: 2026-10-01
updated: 2026-10-01
---

Dữ liệu một case tạo ra trong `setup` phải được xoá trong `teardown` của chính case đó. Không dựa vào dữ liệu do case khác tạo.
