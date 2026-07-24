<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/logo/light.svg">
    <img alt="HyperFrames" src="docs/logo/light.svg" width="300">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hyperframes"><img src="https://img.shields.io/npm/v/hyperframes.svg?style=flat" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/hyperframes"><img src="https://img.shields.io/npm/dm/hyperframes.svg?style=flat" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js"></a>
  <a href="https://discord.gg/EbK98HBPdk"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center"><b>Viết HTML. Render video. Thiết kế cho AI Agent.</b></p>

<p align="center">
  <a href="https://hyperframes.heygen.com/quickstart">Bắt đầu nhanh</a> |
  <a href="https://hyperframes.heygen.com/showcase">Dự án mẫu</a> |
  <a href="https://www.hyperframes.dev/">Sân chơi (Playground)</a> |
  <a href="https://hyperframes.heygen.com/catalog/blocks/data-chart">Danh mục (Catalog)</a> |
  <a href="https://hyperframes.heygen.com/introduction">Tài liệu</a> |
  <a href="https://discord.gg/EbK98HBPdk">Discord</a>
</p>

<p align="center">
  <img src="docs/public/images/hyperframes-logo-motion-1280-trimmed.webp" alt="HyperFrames demo: Mã HTML ở bên trái chuyển thành video hoàn chỉnh ở bên phải" width="800">
</p>

HyperFrames là một framework mã nguồn mở giúp chuyển đổi HTML, CSS, phương tiện (media) và các hiệu ứng hoạt họa (animation) có thể tua được (seekable) thành video MP4 với tính chuẩn xác (deterministic). Bạn có thể sử dụng nó cục bộ qua CLI, từ các AI Agent lập trình thông qua Skills, hoặc làm lõi render cho các hệ thống biên tập hosted.

## Bắt đầu nhanh

### Sử dụng với AI Agent lập trình

Cài đặt các skill của HyperFrames, sau đó mô tả video bạn muốn tạo:

```bash
npx skills add heygen-com/hyperframes --full-depth
```

> Trình chọn (picker) sẽ mở ra mà không chọn sẵn gì cả — nhóm **Core Skills** là tất cả những gì bạn cần: router `/hyperframes` sẽ cài đặt từng quy trình tạo video (creation workflow) theo nhu cầu (on demand). Các Agent hoặc các tiến trình chạy không tương tác nên sử dụng `npx hyperframes skills update` — lệnh này sẽ cài đặt chính xác bộ core skill, thay vì chạy `skills add` không tương tác mà không có tùy chọn `--skill` sẽ cài đặt tất cả 19 skill.
>
> Tùy chọn `--full-depth` thực hiện clone đầy đủ từ nhánh `main` hiện tại của repo. Nếu không có tùy chọn này, `skills add` sẽ lấy dữ liệu từ registry của skills.sh (vốn có thể chậm hơn nhánh `main` vài giờ) — dẫn đến bạn có thể nhận được bản sao cũ của skill (`hyperframes skills update` đã mặc định cài đặt full-depth).

Hãy thử một câu lệnh (prompt) như:

> Sử dụng `/hyperframes`, hãy tạo một video giới thiệu sản phẩm dài 10 giây với tiêu đề xuất hiện từ từ (fade-in), video nền và nhạc nền nhẹ nhàng.

Các skill này dạy cho AI Agent quy trình sản xuất video của HyperFrames: lập kế hoạch video, viết HTML hợp lệ, gắn các animation tua được (seekable), thêm file media, kiểm tra mã (lint), xem trước (preview) và xuất video (render). Chúng hoạt động tốt với Claude Code, Cursor, Gemini CLI, Codex và các AI Agent lập trình hỗ trợ skill.

## Danh sách Skills

HyperFrames đi kèm với 19 skill được Agent tải theo nhu cầu. Hãy đọc `/hyperframes` đầu tiên — đây là bộ định tuyến (router) và bản đồ năng lực; nó chọn quy trình cho bất kỳ yêu cầu "tạo cho tôi một..." nào — video, slide trình chiếu, hay chuyển đổi composition — và trỏ đến các domain skill bên dưới.

Mặc định sử dụng **bộ core skill** — router sẽ cài đặt từng quy trình tạo video theo nhu cầu. Lệnh `npx hyperframes skills update` cài đặt chính xác bộ skill đó ở bất kỳ đâu; trình chọn tương tác (`npx skills add heygen-com/hyperframes --full-depth`) hiển thị nó dưới dạng nhóm "Core Skills" và không chọn sẵn gì cả. Trình chọn chỉ dành cho chế độ tương tác — tiến trình chạy không tương tác hoặc agent chạy mà không có `--skill` sẽ cài đặt tất cả 19 skill. Sử dụng `npx skills add heygen-com/hyperframes --all --full-depth` để cài đặt chủ động cả 19 skill (bỏ qua trình chọn), hoặc `npx skills add heygen-com/hyperframes --skill <name> --full-depth` cho duy nhất một skill (tên thuần, không có dấu `/` ở đầu). Giữ tùy chọn `--full-depth` — nó cài đặt nhánh `main` mới nhất; nếu không có, `skills add` sẽ lấy blob từ skills.sh (thường chậm hơn vài giờ).

Sau đó việc cài đặt luôn gọn nhẹ: `npx hyperframes init` duy trì **bộ core skill** luôn mới (router, các domain skill `hyperframes-*`, và `media-use` — cùng với những gì đã cài đặt sẵn; `/figma` duy trì theo nhu cầu) và không tự động mở rộng cài đặt từng phần; các quy trình tạo video được cài đặt **theo nhu cầu** — router chạy `npx hyperframes skills update <workflow>` trước khi đi vào quy trình. Không có tiến trình nào tự động tải lại toàn bộ bộ skill ở phía sau.

### Tải lên Codex

Tạo file nén Codex plugin sẵn sàng tải lên từ phiên bản `HEAD` đã commit của manifest, tài nguyên thương hiệu và các skill:

```bash
bun run package:codex-plugin
```

Lệnh này ghi file `dist/hyperframes-plugin.zip` với thư mục gốc `hyperframes/` và sẽ báo lỗi nếu dung lượng vượt quá giới hạn 100 MB của Codex.

### Bộ định tuyến (Router)

| Skill          | Trường hợp sử dụng                                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/hyperframes` | **Đọc trước tiên** đối với bất kỳ yêu cầu tạo / chỉnh sửa / làm hoạt họa / render video, animation, hoặc motion graphic. Là bản đồ năng lực cho các domain skill, lớp xác nhận yêu cầu ban đầu và bộ định tuyến cho các quy trình tạo video bên dưới. |

### Quy trình tạo video (Creation workflows)

| Skill                      | Trường hợp sử dụng                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/product-launch-video`    | Bất kỳ **trang web** nào — marketing / ra mắt / quảng bá sản phẩm (từ URL, bản tóm tắt hoặc kịch bản), hoặc video xem thử trang web / truyền thông xã hội với hình ảnh từ chính trang đó. Thời lượng lên đến ~3 phút (lý tưởng nhất 30-90s).                  |
| `/faceless-explainer`      | **Giải thích một chủ đề / khái niệm** từ văn bản bất kỳ — không cần sản phẩm, không cần URL, không cần chụp trang web; mọi hình ảnh đều do LLM tự sáng tạo (typography / đồ họa trừu tượng / sơ đồ / biểu đồ dữ liệu).                                        |
| `/pr-to-video`             | Một **GitHub pull request** (URL PR, ref `owner/repo#N`, hoặc "PR này") → video giải thích changelog / tính năng mới / sửa lỗi / refactor, đọc thông qua `gh` CLI.                                                                                            |
| `/embedded-captions`       | Thêm **phụ đề / nhãn** vào video nói chuyện (talking-head) có sẵn (giữ nguyên gốc video) — thanh phụ đề chuẩn xác, điểm nhấn chèn phía sau nhân vật, hoặc phụ đề điện ảnh.                                                                                    |
| `/talking-head-recut`      | Đóng gói video talking-head / phỏng vấn / podcast có sẵn với **các lớp phủ đồ họa được thiết kế** — khung tiêu đề (lower-thirds), chú thích dữ liệu, tiêu đề động (kinetic titles), trích dẫn, bảng bên hông, PiP.                                            |
| `/motion-graphics`         | **Đồ họa chuyển động ngắn, không thuyết minh, định hướng thiết kế** (~dưới 10s) — chữ động (kinetic type), số liệu / biểu đồ nhảy, logo sting, lower-third, bài viết Twitter / tiêu đề hoạt họa. Xuất MP4 hoặc lớp phủ trong suốt.                            |
| `/music-to-video`          | Một **bản nhạc** (file âm thanh hoặc video lấy tiếng) → video **bắt nhịp theo nhạc (beat-synced)** — phụ đề lời bài hát, slideshow, hoặc quảng cáo động; âm nhạc quyết định nhịp độ.                                                                          |
| `/slideshow`               | Một **bài thuyết trình / pitch deck / slide tương tác** — các slide rời rạc, hiển thị theo phần, phân nhánh, điều hướng điểm nóng, chế độ người thuyết trình. Đầu ra là một bộ slide điều hướng được, không phải video render.                                |
| `/general-video`           | **Bất kỳ trường hợp nào khác** — video dài hoặc nhiều phân cảnh, video thương hiệu / sizzle reel, thẻ tiêu đề, vòng lặp tĩnh, composition tự do. Không giới hạn đầu vào hay độ dài, và là không gian của chế độ đồng hành (co-create cùng đầy đủ bộ công cụ). |
| `/remotion-to-hyperframes` | **Chuyển đổi dự án Remotion (React) có sẵn** sang HTML của HyperFrames. Đây là công cụ di chuyển một chiều, không phải tạo mới.                                                                                                                               |

### Skill chuyên môn (Tải theo nhu cầu)

Các năng lực nguyên tử mà các quy trình tạo video kết hợp sử dụng — hãy nạp skill tương ứng khi bạn cần lớp chức năng cụ thể đó.

| Skill                    | Phạm vi hỗ trợ                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/hyperframes-core`      | Quy ước composition — thuộc tính thời gian `data-*`, `class="clip"`, track, sub-composition, biến, trình phát media của framework, các quy tắc tính chuẩn xác (determinism).                                                                                                                                                                                    |
| `/hyperframes-animation` | Toàn bộ kiến thức animation — quy tắc chuyển động nguyên tử, sơ đồ phân cảnh, hiệu ứng chuyển cảnh (transition), adapter thời gian thực (GSAP / Lottie / Three.js / Anime.js / CSS / WAAPI / TypeGPU).                                                                                                                                                          |
| `/hyperframes-keyframes` | Tạo keyframe an toàn khi tua trên các thư viện — GSAP timeline, CSS keyframe, Anime.js, WAAPI, FLIP, path, mask, SVG morph/draw, độ sâu 3D — cùng công cụ chẩn đoán `hyperframes keyframes` cho chuyển động đã render.                                                                                                                                          |
| `/hyperframes-creative`  | Định hướng sáng tạo ngoài animation — `frame.md` / `design.md`, bảng màu, kiểu chữ (typography), lời thuyết trình, lập kế hoạch nhịp điệu (beat), hình ảnh phản hồi theo âm thanh, mẫu composition.                                                                                                                                                             |
| `/media-use`             | Hệ điều hành media — giải quyết mọi nhu cầu media (BGM, SFX, hình ảnh, icon, logo, giọng nói, phối màu, LUT) thành file cục bộ hoặc block sẵn sàng dán + nhật ký lưu trữ, tạo qua các model TTS/âm nhạc/hình ảnh khi catalog thiếu, phiên âm, tạo phụ đề, xóa nền và tái sử dụng tài nguyên giữa các dự án. Một engine âm thanh dùng chung + theo dõi manifest. |
| `/hyperframes-cli`       | Quy trình phát triển CLI — `init`, `lint`, `check`, `snapshot`, `preview`, `render`, `publish`, `doctor`, cùng render đám mây hosted bởi HeyGen (`cloud render`) và render trên AWS Lambda (`lambda deploy / render / progress`).                                                                                                                               |
| `/hyperframes-registry`  | Cài đặt và kết nối các block & component từ registry vào composition thông qua `hyperframes add`. Xây dựng block hoặc component mới để đóng góp cho dự án.                                                                                                                                                                                                      |
| `/figma`                 | Nhập tài nguyên, token, component và storyboard từ Figma → tái tạo chuyển động (các frame được đọc như trạng thái, không phải slide) (REST/CLI) cùng với animation Motion (MCP) và shader (MCP source / xuất native) vào composition.                                                                                                                           |

Đối với quy trình bàn giao thiết kế giao diện (visual design handoff), hãy xem [Hướng dẫn Claude Design](https://hyperframes.heygen.com/guides/claude-design) và [Hướng dẫn Open Design](https://hyperframes.heygen.com/guides/open-design).

### Thao tác thủ công bằng CLI

```bash
npx hyperframes init my-video
cd my-video
npx hyperframes preview      # xem trước trong trình duyệt với tính năng live reload
npx hyperframes render       # render ra file MP4
```

**Yêu cầu:** Node.js 22+, FFmpeg

## Ứng dụng thực tế

Bạn cần ý tưởng? Hãy xem [Showcase](https://hyperframes.heygen.com/showcase) để tham khảo các video hoàn chỉnh mà bạn có thể xem, đọc mã nguồn, chạy thử và tùy biến.

- Video ra mắt sản phẩm và thông báo tính năng mới
- Hướng dẫn giải thích PR với diff mã nguồn hoạt họa, lời thuyết minh và phụ đề
- Trực quan hóa dữ liệu, đua biểu đồ (chart races) và animation bản đồ
- Video mạng xã hội với phụ đề động, lớp phủ và âm nhạc
- Video giải thích từ tài liệu (Docs-to-video), PDF (PDF-to-video) và tour tham quan trang web
- Đồ họa chuyển động tái sử dụng cho các hệ thống tạo nội dung tự động

## Frame.md

**frame.md — hệ thống thiết kế của bạn, sẵn sàng cho video.**

Mọi thương hiệu đều có một file `design.md`. Nhưng không file nào trong số đó được viết cho ống kính máy quay. `frame.md` chính là lớp chuyển ngữ còn thiếu: nó nhận thông số thiết kế từ ngữ cảnh web và đảo ngược nó cho khung hình video — giữ nguyên các token, giữ nguyên các quy tắc, nhưng được viết lại để AI Agent có thể dựng video quảng cáo mà không cần phải đoán tỷ lệ hay phụ thuộc vào giao diện web.

Đầu ra là một bản mở rộng `DESIGN.md` (superset) mà toàn bộ chuỗi công cụ của bạn đều có thể đọc được. Các thiết kế cơ bản (atoms) được giữ nguyên giá trị. Việc bố cục (composition) hoàn toàn tự do. Các con số được lấy từ kịch bản.

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/biennale-yellow"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/biennale-yellow.png" alt="Biennale Yellow" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/biennale-yellow">Biennale Yellow</a></b>
    </td>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/blockframe"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/blockframe.png" alt="BlockFrame" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/blockframe">BlockFrame</a></b>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/blue-professional"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/blue-professional.png" alt="Blue Professional" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/blue-professional">Blue Professional</a></b>
    </td>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/bold-poster"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/bold-poster.png" alt="Bold Poster" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/bold-poster">Bold Poster</a></b>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/broadside"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/broadside.png" alt="Broadside" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/broadside">Broadside</a></b>
    </td>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/capsule"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/capsule.png" alt="Capsule" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/capsule">Capsule</a></b>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/cartesian"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/cartesian.png" alt="Cartesian" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/cartesian">Cartesian</a></b>
    </td>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/cobalt-grid"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/cobalt-grid.png" alt="Cobalt Grid" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/cobalt-grid">Cobalt Grid</a></b>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/coral"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/coral.png" alt="Coral" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/coral">Coral</a></b>
    </td>
    <td width="50%" align="center">
      <a href="https://www.hyperframes.dev/design/creative-mode"><img src="https://static.heygen.ai/hyperframes-oss/docs/images/design-templates/creative-mode.png" alt="Creative Mode" width="100%"></a>
      <br><b><a href="https://www.hyperframes.dev/design/creative-mode">Creative Mode</a></b>
    </td>
  </tr>
</table>

Khám phá và tùy biến tất cả mẫu tại [hyperframes.dev/design](https://www.hyperframes.dev/design).

## Cách thức hoạt động

Định nghĩa video bằng HTML. Thêm các thuộc tính data cho thời gian và track. Sử dụng GSAP, CSS, Lottie, Three.js, Anime.js, WAAPI hoặc frame adapter tùy chỉnh của riêng bạn cho animation tua được (seekable).

```html
<div id="stage" data-composition-id="launch" data-start="0" data-width="1920" data-height="1080">
  <video
    class="clip"
    data-start="0"
    data-duration="6"
    data-track-index="0"
    src="intro.mp4"
    muted
    playsinline
  ></video>

  <h1 id="title" class="clip" data-start="1" data-duration="4" data-track-index="1">Launch day</h1>

  <audio
    data-start="0"
    data-duration="6"
    data-track-index="2"
    data-volume="0.5"
    src="music.wav"
  ></audio>

  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: 40, duration: 0.8 }, 1);
    window.__timelines = window.__timelines || {};
    window.__timelines.launch = tl;
  </script>
</div>
```

Xem trước tức thì trong trình duyệt. Render cục bộ hoặc trong Docker. Trình render sẽ tua (seek) từng khung hình trong Chrome headless và mã hóa kết quả bằng FFmpeg, đảm bảo cùng một đầu vào sẽ luôn cho ra cùng một video chuẩn xác.

## Hệ sinh thái HyperFrames

HyperFrames là một render engine mã nguồn mở, đi kèm với bộ công cụ đang ngày càng phát triển xung quanh việc tạo video thuần HTML.

| Thành phần                                      | Trạng thái                | Chức năng                                                                                       |
| ----------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| CLI                                             | Sẵn sàng                  | Tạo bộ khung (scaffold), xem trước, kiểm tra mã, soi chi tiết và render các dự án video cục bộ  |
| Core / Engine / Producer                        | Sẵn sàng                  | Phân tích composition, điều khiển Chrome headless, mã hóa video và trộn âm thanh                |
| Catalog                                         | Sẵn sàng                  | Các block và component tái sử dụng cho hiệu ứng chuyển cảnh, lớp phủ, phụ đề, biểu đồ, bản đồ   |
| Agent skills                                    | Sẵn sàng                  | Dạy cho AI Agent các quy trình sản xuất video mà tài liệu web thông thường không đề cập         |
| Studio                                          | Sẵn sàng, đang phát triển | Giao diện trình duyệt để xem trước và chỉnh sửa composition                                     |
| AWS Lambda rendering                            | Sẵn sàng                  | Triển khai hệ thống render phân tán và điều khiển render từ máy tính của bạn hoặc CI            |
| [hyperframes.dev](https://www.hyperframes.dev/) | Sẵn sàng                  | Sân chơi cộng đồng để xem trước, thử nghiệm, chia sẻ và render các dự án video thuần HTML       |
| [frame.md](https://www.hyperframes.dev/design)  | Sẵn sàng                  | Đảo ngược hệ thống thiết kế của bạn cho khung hình video — một bản mở rộng giúp Agent tạo video |

## Danh mục Catalog

Cài đặt các block và component sẵn sàng sử dụng:

```bash
npx hyperframes add flash-through-white   # hiệu ứng chuyển cảnh shader
npx hyperframes add instagram-follow      # lớp phủ mạng xã hội
npx hyperframes add data-chart            # biểu đồ chuyển động
```

Duyệt catalog tại [hyperframes.heygen.com/catalog](https://hyperframes.heygen.com/catalog/blocks/data-chart).

## Tại sao chọn HyperFrames?

- **Thuần HTML (HTML-native):** Các composition là file HTML với thuộc tính data. Không bắt buộc dùng React, không sử dụng định dạng timeline độc quyền.
- **Thân thiện với Agent (Agent-friendly):** AI Agent đã quen thuộc với việc viết HTML, và CLI mặc định chạy ở chế độ không tương tác.
- **Tính chuẩn xác (Deterministic):** Cùng đầu vào, cùng khung hình, cùng đầu ra. Được thiết kế cho CI, kiểm thử regression và render tự động.
- **Không cần bước build:** Một composition `index.html` chạy trực tiếp và có thể xem trước ngay trong trình duyệt.
- **Animation dựa trên Adapter:** Hỗ trợ GSAP, CSS animation, Lottie, Three.js, Anime.js, WAAPI hoặc runtime tùy chỉnh.
- **Mã nguồn mở:** Giấy phép Apache 2.0, không phí theo lượt render hay giới hạn sử dụng thương mại.

## HyperFrames vs Remotion

HyperFrames lấy cảm hứng từ [Remotion](https://www.remotion.dev). Cả hai công cụ đều render video bằng Chrome headless và FFmpeg. Điểm khác biệt chính nằm ở mô hình biên soạn: Remotion tập trung vào React component; trong khi HyperFrames lựa chọn HTML thuần túy mà cả con người và AI Agent đều có thể viết dễ dàng.

|                    | **HyperFrames**                       | **Remotion**                               |
| ------------------ | ------------------------------------- | ------------------------------------------ |
| Mô hình biên soạn  | HTML + CSS + animation tua được       | React components                           |
| Bước build         | Không có; `index.html` chạy trực tiếp | Đòi hỏi Bundler                            |
| Bàn giao cho Agent | File HTML thuần túy                   | Dự án JSX / React                          |
| Animation thư viện | Tua được, chính xác từng khung hình   | Animation thời gian thực cần xử lý kỹ      |
| Render phân tán    | Luồng render Cục bộ & AWS Lambda      | Remotion Lambda, cloud renderer hoàn thiện |
| Giấy phép          | Apache 2.0                            | Giấy phép Remotion (Source-available)      |

Đọc bản so sánh chi tiết tại [Hướng dẫn HyperFrames vs Remotion](https://hyperframes.heygen.com/guides/hyperframes-vs-remotion).

## Tài liệu hướng dẫn

Tài liệu đầy đủ: [hyperframes.heygen.com/introduction](https://hyperframes.heygen.com/introduction)

- [Bắt đầu nhanh (Quickstart)](https://hyperframes.heygen.com/quickstart)
- [Dự án mẫu (Showcase)](https://hyperframes.heygen.com/showcase)
- [Hướng dẫn (Guides)](https://hyperframes.heygen.com/guides/gsap-animation)
- [Tài liệu API (API Reference)](https://hyperframes.heygen.com/packages/core)
- [Danh mục (Catalog)](https://hyperframes.heygen.com/catalog/blocks/data-chart)
- [Ví dụ (Examples)](https://hyperframes.heygen.com/examples)
- [Render trên AWS Lambda](https://hyperframes.heygen.com/deploy/aws-lambda)

## Các gói (Packages)

| Gói                                                              | Mô tả                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`hyperframes`](packages/cli)                                    | CLI cho việc tạo, xem trước, kiểm tra mã và render composition     |
| [`@hyperframes/core`](packages/core)                             | Kiểu dữ liệu, parser, generator, linter, runtime và frame adapter  |
| [`@hyperframes/engine`](packages/engine)                         | Engine chụp từng trang sang video tua được dùng Puppeteer & FFmpeg |
| [`@hyperframes/producer`](packages/producer)                     | Quy trình render đầy đủ cho chụp khung hình, mã hóa & trộn tiếng   |
| [`@hyperframes/studio`](packages/studio)                         | Giao diện chỉnh sửa composition trên trình duyệt                   |
| [`@hyperframes/player`](packages/player)                         | Web component `<hyperframes-player>` có thể nhúng vào trang web    |
| [`@hyperframes/shader-transitions`](packages/shader-transitions) | Chuyển cảnh WebGL shader cho các composition                       |
| [`@hyperframes/aws-lambda`](packages/aws-lambda)                 | AWS Lambda SDK và môi trường triển khai cho render phân tán        |

## Cộng đồng

HyperFrames được sử dụng chính thức tại [HeyGen](https://www.heygen.com), cùng với các ví dụ cộng đồng từ các đội ngũ như [tldraw](https://tldraw.com), [TanStack](https://tanstack.com) và các đơn vị khác trong [ADOPTERS.md](ADOPTERS.md). Hãy mở PR nếu đội ngũ của bạn đang sử dụng HyperFrames.

- Câu hỏi và ý tưởng: [Discord](https://discord.gg/EbK98HBPdk)
- Báo lỗi và yêu cầu tính năng: [GitHub Issues](https://github.com/heygen-com/hyperframes/issues)
- Báo cáo bảo mật: [SECURITY.md](SECURITY.md)
- Đóng góp phát triển: [CONTRIBUTING.md](CONTRIBUTING.md)

## Ghi chú cho nhà phát triển

Kho lưu trữ này sử dụng [Git LFS](https://git-lfs.com) cho các dữ liệu test regression mẫu tại `packages/producer/tests/**/output.mp4` (khoảng 240 MB các file `.mp4`). Nếu bạn clone toàn bộ repo để phát triển, hãy cài đặt Git LFS trước:

```bash
# macOS
brew install git-lfs

# Ubuntu / Debian
sudo apt install git-lfs

# Windows
winget install GitHub.GitLFS

# Sau đó, chạy một lần trên mỗi máy
git lfs install
```

Nếu bạn chỉ cần mã nguồn, bạn có thể bỏ qua dữ liệu LFS:

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/heygen-com/hyperframes.git
```

## Giấy phép

[Apache 2.0](LICENSE)
