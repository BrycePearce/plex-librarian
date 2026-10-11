/// <reference lib="dom" />
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-types="@types/react-test-renderer"
import TestRenderer, { act } from "react-test-renderer";
import { MediaArtworkFallback, PosterThumb } from "./PosterThumb.tsx";

Deno.test("artwork fallbacks distinguish movies, television, music and unknown media", () => {
  for (
    const [type, icon] of [
      ["movie", "film"],
      ["tv", "tv"],
      ["show", "tv"],
      ["season", "tv"],
      ["episode", "tv"],
      ["artist", "music-2"],
      ["album", "music-2"],
      ["track", "music-2"],
      ["music", "music-2"],
      ["other", "images"],
    ]
  ) {
    const html = renderToStaticMarkup(
      <PosterThumb thumb={null} mediaType={type} width={60} height={90} className="w-10 h-14" />,
    );
    assertStringIncludes(html, `lucide-${icon}`);
    assertStringIncludes(html, 'aria-hidden="true"');
    assertEquals(html.includes("<img"), false);
  }
});

for (const hoverScope of [undefined, "row", "poster"] as const) {
  Deno.test(`failed artwork falls back and retries when its source changes (${hoverScope ?? "plain"})`, async () => {
    const poster = (thumb: string) => (
      <PosterThumb
        thumb={thumb}
        mediaType="movie"
        width={60}
        height={90}
        className="w-10 h-14"
        hoverScope={hoverScope}
      />
    );
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await act(() => {
      renderer = TestRenderer.create(poster("/old"));
    });
    try {
      const image = renderer.root.findByType("img");
      assertStringIncludes(image.props.src, "path=%2Fold");
      await act(() => image.props.onError());
      assertEquals(renderer.root.findAllByType("img").length, 0);
      assertEquals(renderer.root.findByType(MediaArtworkFallback).props.mediaType, "movie");
      await act(() => renderer.update(poster("/new")));
      assertStringIncludes(renderer.root.findByType("img").props.src, "path=%2Fnew");
      assertEquals(renderer.root.findAllByType(MediaArtworkFallback).length, 0);
    } finally {
      await act(() => renderer.unmount());
    }
  });
}
