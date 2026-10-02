---
id: dbadmin-fixture-only
type: convention
title: Kết nối ghi DB chỉ dùng trong fixture
source: user
created: 2026-10-01
updated: 2026-10-01
---

`dbadmin_query` chỉ dùng trong `setup`/`teardown`. Không khai báo `dbadmin` trong `requires`, để agent chạy test không có quyền ghi dữ liệu.
