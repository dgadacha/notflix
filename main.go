// Notflix — Netflix-style live-action films self-hosted.
//
// Architecture echoes Kuro (the anime fork): a single Go binary with the
// React build embedded via //go:embed serves both the API and the UI on the
// same port. TMDB is proxied through the backend so the API key stays on
// the server side; Vidsrc URLs are constructed client-side and rendered in
// an iframe (no streaming proxy needed).
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"

	"notflix/internal/core"
	"notflix/internal/handlers"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

//go:embed all:web
var embeddedWeb embed.FS

func main() {
	app, err := core.New()
	if err != nil {
		log.Fatalf("notflix: failed to initialize: %v", err)
	}
	defer app.Close()

	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Recover())
	e.Use(middleware.Logger())

	// CORS — the dev frontend (rsbuild) runs on :43210 while the API
	// listens on :43212. Session cookies require AllowCredentials: true,
	// which means AllowOrigins can't be a wildcard — we list the dev
	// origins explicitly. In production the SPA is served by this same
	// Echo instance (same-origin) so CORS doesn't fire there.
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{
			"http://127.0.0.1:43210",
			"http://localhost:43210",
		},
		AllowCredentials: true,
		AllowMethods: []string{
			http.MethodGet, http.MethodHead, http.MethodPost,
			http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions,
		},
		AllowHeaders: []string{
			echo.HeaderOrigin, echo.HeaderContentType, echo.HeaderAccept,
			echo.HeaderAuthorization, echo.HeaderXRequestedWith, echo.HeaderCookie,
		},
	}))

	// API routes (all prefixed with /api/v1).
	h := handlers.New(app)
	handlers.RegisterRoutes(e, h)

	// Static frontend — served from the embedded FS. Anything that isn't
	// /api/* gets the SPA index.html (client-side router takes over).
	webFS, _ := fs.Sub(embeddedWeb, "web")
	e.GET("/static/*", echo.WrapHandler(http.FileServer(http.FS(webFS))))
	e.GET("/*", func(c echo.Context) error {
		idx, err := fs.ReadFile(webFS, "index.html")
		if err != nil {
			return c.String(http.StatusInternalServerError, "web build missing — run `make build-web` first")
		}
		return c.Blob(http.StatusOK, "text/html; charset=utf-8", idx)
	})

	addr := app.Config.Server.Host + ":" + app.Config.PortStr()
	log.Printf("notflix: listening on http://%s", addr)
	if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
