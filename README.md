# aitest

Nền tảng cho AI agent tự đọc test plan, tự thực thi các bước qua MCP và xuất báo cáo. Nền tảng dựng trên [cordis](https://github.com/cordiverse/cordis) theo kiến trúc "mọi thứ là plugin" của [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Agent mặc định là Kiro, kết nối qua ACP (Agent Client Protocol).

- Hướng dẫn sử dụng (soạn plan, chạy, đọc báo cáo, xử lý sự cố): [docs/user-guide.md](docs/user-guide.md)
- Thiết kế và hướng dẫn viết plugin: [docs/architecture.md](docs/architecture.md)

## Yêu cầu

- Node.js 22.18 trở lên, pnpm 11
- `kiro-cli` đã đăng nhập (`kiro-cli acp --help` chạy được)
- macOS, Linux hoặc Windows 11. Bộ test đã chạy thật trên macOS và Linux; Windows được kiểm chứng qua CI (`.github/workflows/ci.yml`). Chi tiết ở mục 2.2 của [hướng dẫn sử dụng](docs/user-guide.md).

## Bắt đầu nhanh

```bash
pnpm install
pnpm test                      # bộ kiểm thử end-to-end với agent kịch bản, không cần LLM

pnpm demo:api                  # terminal 1: chạy Order API mẫu ở cổng 4100
pnpm aitest validate examples/plans/order.plan.yaml
pnpm aitest run examples/plans/order.plan.yaml              # terminal 2: Kiro thực thi 3 case
pnpm aitest run examples/plans/order.plan.yaml --case TC-01
```

Test integration (webhook, xử lý bất đồng bộ, fixture) và E2E qua trình duyệt (cần Google Chrome):

```bash
pnpm aitest run examples/plans/order-integration.plan.yaml
pnpm aitest -c aitest.e2e.yml run examples/plans/order-ui.plan.yaml
```

Kết quả mong đợi với `order.plan.yaml`: TC-01 và TC-02 đạt. TC-03 không đạt vì Order API mẫu có lỗi cố ý: API không từ chối lệnh lẻ lô.

## Soạn test plan cùng AI

Chat với agent trên giao diện web. Agent đọc đặc tả, khảo sát hệ thống, soạn plan, kiểm tra và chạy thử. Bạn duyệt trước khi agent chạy thử hoặc lưu plan.

```bash
pnpm web:build
pnpm aitest -c aitest.web.yml serve     # mở http://127.0.0.1:4300
```

Trang **Plan** quản lý plan: tìm, lọc theo kết quả lần chạy gần nhất, xem case và lịch sử chạy, chạy plan (chọn case, điền đầu vào), mở plan để sửa cùng agent. Tab **Lượt chạy** cho xem lại agent đã làm gì trong từng case và vì sao ra kết quả đó: giá trị thật nền tảng đọc được, evidence, prompt, dòng thời gian; lượt chạy đang diễn ra được cập nhật liên tục. Trang **Knowledge** lưu tri thức của nhóm trong `kb/`: lỗi đã biết (báo cáo tách lỗi đã biết khỏi lỗi mới), quy ước (agent soạn plan luôn áp dụng), bài học. Giao diện có thêm trang **Plugin** (bật/tắt, cấu hình, thêm plugin, thêm MCP server) và trang **Tool** (bật/tắt, chạy thử từng tool). Thay đổi ghi vào `aitest.web.patch.yml`, không sửa cấu hình gốc.

Người dùng terminal có thể dùng Kiro chat với cùng bộ tool: `kiro-cli chat --agent aitest-author`.

Mỗi lượt chạy tạo thư mục `.aitest/runs/<run-id>/` gồm:

| File | Nội dung |
|---|---|
| `events.jsonl` | Run log append-only, nguồn sự thật của mọi báo cáo |
| `report.md` | Báo cáo cho người đọc: expectation, giá trị thật, chuỗi action |
| `junit.xml` | Báo cáo cho CI |

Dựng lại báo cáo từ log: `pnpm aitest report .aitest/runs/<run-id>/events.jsonl`.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `aitest run <plan> [--case A,B] [--agent kiro]` | Chạy plan; mã thoát khác 0 khi có case không đạt |
| `aitest validate <plan>` | Kiểm tra schema và namespace action |
| `aitest actions` | Liệt kê action đã đăng ký |
| `aitest report <events.jsonl>` | Dựng lại báo cáo từ run log |
| `aitest -c aitest.web.yml serve` | Chạy giao diện web soạn plan cùng agent |
| `aitest mcp` | Chạy MCP server soạn plan qua stdio, cho Kiro chat hoặc agent khác |

Tuỳ chọn `-c <file>` chọn file cấu hình plugin, mặc định là `aitest.yml`.

## Soạn test plan

```yaml
# yaml-language-server: $schema=../../docs/plan.schema.json
id: TP-ORDER-001
name: Đặt lệnh qua Order API
requires: [http, db]
vars:
  base_url: ${env.ORDER_API_URL:-http://127.0.0.1:4100}
cases:
  - id: TC-01
    title: Đặt lệnh mua hợp lệ
    steps:
      - Gọi POST {{base_url}}/orders với body {"symbol":"VNM","side":"BUY","qty":100,"price":70000}.
      - Truy vấn bảng orders theo id vừa nhận.
    expect:
      - id: http-201
        desc: API trả về HTTP 201
        check: { op: eq, value: 201 }
```

Giá trị mong đợi cần tính toán dùng công thức, ví dụ `check: { op: eq, expr: "round(qty * price / 1000 * 0.0015, 2, HALF_UP)" }`: nền tảng tính bằng số thập phân chính xác từ dữ liệu thật, agent không tự tính.

Bước viết bằng ngôn ngữ tự nhiên. Tiêu chí `check` là cố định: agent chỉ chọn evidence để đối chiếu, còn nền tảng tự so sánh với giá trị thật.

Plan có thể khai báo `setup`/`teardown` để chuẩn bị và dọn dữ liệu. Runner chạy các bước này một cách xác định, không qua AI. Chi tiết tại mục 6 của [docs/architecture.md](docs/architecture.md).

## Mở rộng

Mỗi thành phần là một row trong `aitest.yml`:

```yaml
plugins:
  - id: action-clock
    name: ./examples/plugins/action-clock.ts
    config: { timezone: Asia/Ho_Chi_Minh }
```

| Muốn thêm | Cách làm |
|---|---|
| Action mới | Plugin gọi `ctx.actions.register(...)` |
| MCP server có sẵn (Postgres, Kafka...) | Row `@aitest/action-mcp-proxy`, không cần code |
| Tool để agent tự đề xuất trong chat | File `tool-catalog/<id>.yml`: plugin, tham số, mẫu cấu hình chỉ đọc; người dùng duyệt trước khi nạp |
| Chạy một plan trên nhiều môi trường (DB, broker, server khác nhau) | `envs/<tên>.yml` ghi đè cấu hình tool theo mã row; chọn bằng `--env` hoặc trên giao diện |
| Mô tả service dưới kiểm thử để mọi plan dùng lại | `systems/<id>/service.yml` (trỏ tới OpenAPI) và `envs/<môi trường>.yml`; plan khai báo `systems: [<id>]` |
| Kiểm tra sự kiện Kafka, RabbitMQ | Có sẵn `@aitest/action-kafka`, `@aitest/action-rabbitmq`; xem `aitest.events.yml` |
| Chính sách an toàn | Plugin lắng nghe `action/before` |
| Agent ACP khác | Row `@aitest/agent-acp` với `command` khác |
| Định dạng plan khác | Plugin gọi `ctx.plans.registerFormat(...)` |
| Reporter | Plugin lắng nghe `run/report` |

Chi tiết tại mục 8 của [docs/architecture.md](docs/architecture.md).
