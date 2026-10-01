# aitest

Nền tảng cho AI agent tự đọc test plan, tự thực thi các bước qua MCP và xuất báo cáo. Nền tảng dựng trên [cordis](https://github.com/cordiverse/cordis) theo kiến trúc "mọi thứ là plugin" của [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Agent mặc định là Kiro, kết nối qua ACP (Agent Client Protocol).

- Hướng dẫn sử dụng (soạn plan, chạy, đọc báo cáo, xử lý sự cố): [docs/user-guide.md](docs/user-guide.md)
- Thiết kế và hướng dẫn viết plugin: [docs/architecture.md](docs/architecture.md)

## Yêu cầu

- Node.js 22.18 trở lên, pnpm 11
- `kiro-cli` đã đăng nhập (`kiro-cli acp --help` chạy được)

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
| Chính sách an toàn | Plugin lắng nghe `action/before` |
| Agent ACP khác | Row `@aitest/agent-acp` với `command` khác |
| Định dạng plan khác | Plugin gọi `ctx.plans.registerFormat(...)` |
| Reporter | Plugin lắng nghe `run/report` |

Chi tiết tại mục 7 của [docs/architecture.md](docs/architecture.md).
