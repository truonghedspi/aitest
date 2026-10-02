# AGENTS.md — Package

Các quy tắc dưới đây bổ sung cho [quy ước chung](../AGENTS.md#quy-ước).

- **Dạng export của plugin.** Package service export mặc định class kế thừa `Service` (ví dụ `mcp-gateway`, `runner`). Package plugin dạng hàm export có tên `name`, `inject`, `Config`, `apply` và không có export mặc định. Không trộn hai dạng.
- **Khai báo `inject` đầy đủ.** Plugin dùng `ctx.<service>` phải liệt kê service đó trong `inject`, để plugin chờ service xuất hiện thay vì ném lỗi khi nạp.
- **`Config` dùng schemastery** (`z` export từ `@aitest/core`) và có `.description()` tiếng Việt cho trường không hiển nhiên. Giá trị mặc định phải an toàn: chỉ đọc, giới hạn thời gian, không mở cổng ra ngoài `127.0.0.1`.
- **Phụ thuộc:** mọi package khai báo `@aitest/core: workspace:*` và `@deepseek-ai/cordis: ~4.0.4`. Package mới thêm vào `dependencies` của `package.json` gốc để `aitest.yml` phân giải được.
- **Plugin không import lẫn nhau.** Giao tiếp qua service và event trong `@aitest/core`. Hàm dùng chung đặt trong core (ví dụ `readPath`, `compare` ở `core/src/match.ts`). Ngoại lệ hiện có: `runner` dùng kiểu của `mcp-gateway`; `authoring` dùng kiểu của `runner`; `chat` dùng `authoring`, `mcp-gateway`, `web-host`; `plan-manager` dùng kiểu của `authoring`, `runner`, `web-host`.
- **`core/src/types.ts` chỉ chứa kiểu**, không chứa mã chạy.
- **Trạng thái theo case** lưu trong `WeakMap<CaseScope, ...>` của plugin, không gắn thêm trường vào `CaseScope`. Tài nguyên theo case (sink webhook, endpoint) dọn ở `case/end` hoặc qua hàm `close` trả về.
- **Tài nguyên dài hạn** (HTTP server, kết nối DB, process con) mở lười khi cần và đóng trong `ctx.effect`. Process con phải bị dừng khi plugin unload.
- **Mô tả tool viết từ góc nhìn của agent.** Chỉ nêu khái niệm cần cho nhiệm vụ: tham số, kết quả, cách dùng kết quả để assert. Không nhắc chi tiết triển khai hay transport.
- **Khai báo `scopes` cho action.** Mặc định `['case', 'explore']`. Tool soạn plan dùng `['authoring']`; tool chỉ có nghĩa trong test case (assert, webhook) dùng `['case']`. Action có thể ghi dữ liệu nhưng có lời gọi chỉ đọc khai báo `isReadOnlyCall(args)` để `explore` dùng được.
- **`present(args, outcome)` là hàm thuần**, không I/O, không đọc trạng thái, vì được gọi cả khi chạy lẫn khi dựng lại từ log. `view.kind` mới cần một thành phần trong plugin `web-client` tương ứng; kind không có thành phần dùng thẻ mặc định.
- **Tool chỉ bị ẩn bằng `ctx.actions.restrict`**, không xoá khỏi registry; đăng ký action phải gọi từ chính context của plugin để kernel xác định được plugin sở hữu.
- **Plugin soạn plan đóng góp section hướng dẫn** qua `ctx.authoring.guideSection`, mô tả tool của chính plugin đó từ góc nhìn agent.
- **Action có tác động lâu dài** (thêm tool, đổi cấu hình) gọi `scope.confirm` kèm `preview` có `kind`, khai báo `selfConfirm`, và ném lỗi khi scope không có `confirm`. Kiểm tra đầu vào trước khi hỏi để người dùng chỉ duyệt đề xuất hợp lệ.
- **Plugin broker chỉ quan sát mặc định.** Không lấy bản tin khỏi queue hay commit offset của consumer thật; tool gửi bản tin chỉ đăng ký khi cấu hình bật. Gắn handler `error` cho mọi kết nối và channel.
- **Action trả lỗi bằng `throw`.** Pipeline chuẩn hoá thành `status: error`. Kết quả hợp lệ nhưng không đạt điều kiện (hết thời gian chờ, chưa nhận đủ callback) trả về bình thường kèm `satisfied: false`, để verdict quyết định.
- **README theo package** chỉ thêm khi package có cấu hình hoặc giới hạn mà tài liệu kiến trúc chưa nêu.
