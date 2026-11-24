# CLAUDE.md

클로드 클라우드(claude.ai/code)에서 이 저장소를 열고 기능을 추가·수정할 때 읽는 작업 규칙입니다.

## 프로젝트

한국어 그림판 PWA. `main`에 푸시하면 GitHub Pages(<https://liumiul.github.io/paint-app/>)에 바로 반영됩니다.
**외부 라이브러리, CDN, 빌드 도구, npm을 쓰지 않습니다.** 파일을 저장하면 그대로 실행되는 상태를 유지하세요.

## 파일 구조

| 파일 | 역할 |
| --- | --- |
| `index.html` | 화면 구조. 도구 버튼은 `data-tool="pen"` 형태, 아이콘은 인라인 SVG |
| `styles.css` | 레이아웃·테마. 위에서부터 상단바 / 캔버스 / 색상바 / 도구바 순서의 flex 열 |
| `app.js` | 로직 전체 (IIFE 하나). 아래 "구조" 참고 |
| `sw.js` | 서비스 워커. 앱 껍데기 캐시, 네트워크 우선 |
| `manifest.webmanifest` | PWA 설정 (이름, 아이콘, 테마 색) |
| `tools/make_icons.py` | 아이콘 생성 (Pillow) |
| `README.md` | 사용자용 설명. 기능이 바뀌면 함께 갱신 |

## app.js 구조

```
상수        PAPER, MAX_HISTORY(80), FILL_TOLERANCE, PALETTE, TOOLS
state       tool, color, size, dpr, ops[], index, 진행 중 포인터 상태
캔버스 크기  resizeCanvases() — devicePixelRatio 반영, 크기 변경 시 내용 보존
그리기      applyStyle, segWidth, drawDot, drawStroke, drawShape
페인트통    floodFill(x, y, color) — 스캔라인, 픽셀 단위
히스토리    pushOp, paintOp, replay, undo, redo, trimHistory
저장        savePNG — 흰 배경 위에 합성 후 toBlob
입력        onPointerDown/Move/Up/Cancel, addPoint, drawPreview
UI          setTool, setColor, updateSizeDot, 단축키
```

### 좌표 규칙 (중요)

- 그리기 좌표는 **캔버스의 CSS 픽셀**. 실제 비트맵은 `devicePixelRatio`배이며 `ctx.setTransform(dpr, …)`이 보정합니다.
- CSS 값을 다시 계산할 때는 `board.getBoundingClientRect()` 기준을 유지하세요.
- `getImageData`/`putImageData`는 변환의 영향을 받지 않으므로 픽셀 좌표에는 `state.dpr`을 곱합니다.

### 히스토리 연산 스키마

| type | 필드 |
| --- | --- |
| `stroke` | `tool`, `color`, `size`, `pressure`(bool), `points[{x, y, p}]` |
| `shape` | `tool`(line/rect/ellipse), `color`, `size`, `start{x,y}`, `end{x,y}`, `square` |
| `fill` | `x`, `y`, `color` |
| `clear` | — |

- 새 기능도 **연산으로 표현**해야 실행 취소가 됩니다. 비트맵을 직접 바꾸고 연산을 남기지 않으면 되돌릴 수 없습니다.
- 실시간으로 그리는 모양과 `replay()` 결과가 같아야 합니다. `drawStroke`를 실시간 경로에서도 재사용하거나, 같은 순서로 세그먼트를 그리세요.

## 새 도구 추가 절차

1. `TOOLS`에 `{ label, width, alpha, composite, cursor }` 추가
2. `index.html` 도구바에 `<button class="tool" data-tool="새도구">` 추가 (아이콘 SVG + 한국어 라벨)
3. 필요하면 `styles.css` `.toolbar`의 `grid-template-columns: repeat(7, …)` 개수 수정
4. `onPointerDown`/`onPointerUp`에서 그리기 처리, 히스토리 연산은 `paintOp`에 분기 추가
5. `KEY_TOOLS`에 단축키 등록, README 단축키 표 갱신

## 지켜야 할 것

- **UI 문구는 한국어**, 버튼에는 `aria-label`과 `title`(단축키 포함)을 답니다.
- **상대 경로만 사용**(`./styles.css`). GitHub Pages 하위 경로(`/paint-app/`)에서 동작해야 합니다.
- 툴바는 캔버스를 덮지 않습니다. 캔버스는 `.stage`의 남는 공간을 채우고, 새 UI는 기존 바 안에 넣거나 필요하면 접이식으로 넣으세요.
- 모바일에서 스크롤·확대가 끼어들지 않도록 캔버스에 `touch-action: none`을 유지합니다.
- `sw.js`의 캐시 목록에 새 파일을 추가하고, 캐시 전략을 바꾸면 `VERSION`을 올리세요.
- 파일을 추가·삭제하면 README의 파일 구조 표도 갱신합니다.

## 하지 말 것

- npm/CDN/프레임워크 도입, 번들러 설정 추가
- 사용자 확인 없이 기존 도구·단축키 동작을 바꾸기
- `localStorage`에 그림 데이터를 저장하기(용량·개인정보 문제). 필요하면 사용자에게 먼저 묻기

## 확인 체크리스트

변경 후 브라우저에서 직접 확인합니다.

1. 콘솔에 오류가 없고, 캔버스에 펜·형광펜·지우개가 그려진다.
2. 직선·사각형·원 미리보기가 손을 떼면 확정된다.
3. 페인트통이 도형 안쪽만 채운다.
4. 실행 취소/다시 실행이 그린 순서대로 정확히 되돌아간다(최소 30단계).
5. PNG 저장 시 배경이 흰색으로 나온다.
6. 좁은 화면(360×800)과 PC(1280×800)에서 툴바가 캔버스를 가리지 않는다.
