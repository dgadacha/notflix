package codegen

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// GenerateHandlerHookEvents generates hook_events.go file for handlers
func GenerateHandlerHookEvents(handlersJsonPath string, outputDir string) {
	// Create output directory if it doesn't exist
	err := os.MkdirAll(outputDir, os.ModePerm)
	if err != nil {
		panic(err)
	}

	// Read handlers.json
	handlersJson, err := os.ReadFile(handlersJsonPath)
	if err != nil {
		panic(err)
	}

	// Parse handlers.json
	var handlers []RouteHandler
	err = json.Unmarshal(handlersJson, &handlers)
	if err != nil {
		panic(err)
	}

	// Create hook_events.go file
	outFilePath := filepath.Join(outputDir, "hook_events.go")
	f, err := os.Create(outFilePath)
	if err != nil {
		panic(err)
	}
	defer f.Close()

	// Write package declaration and imports
	f.WriteString("package handlers\n\n")
	f.WriteString("import (\n")
	//f.WriteString("\t\"notflix/internal/hook_resolver\"\n")

	imports := []string{
		"\"notflix/internal/api/anilist\"",
		"\"notflix/internal/api/tvdb\"",
		"\"notflix/internal/continuity\"",
		"\"notflix/internal/database/models\"",
		"\"notflix/internal/debrid/client\"",
		"\"notflix/internal/debrid/debrid\"",
		"\"notflix/internal/extension\"",
		"hibikemanga \"notflix/internal/extension/hibike/manga\"",
		"hibikeonlinestream \"notflix/internal/extension/hibike/onlinestream\"",
		"hibiketorrent \"notflix/internal/extension/hibike/torrent\"",
		"\"notflix/internal/extension_playground\"",
		"\"notflix/internal/extension_repo\"",
		"\"notflix/internal/hook_resolver\"",
		"\"notflix/internal/library/anime\"",
		"\"notflix/internal/library/summary\"",
		"\"notflix/internal/manga\"",
		"\"notflix/internal/manga/downloader\"",
		"\"notflix/internal/mediastream\"",
		"\"notflix/internal/onlinestream\"",
		"\"notflix/internal/report\"",
		"\"notflix/internal/sync\"",
		"\"notflix/internal/torrent_clients/torrent_client\"",
		"\"notflix/internal/torrents/torrent\"",
		"\"notflix/internal/torrentstream\"",
		"\"notflix/internal/updater\"",
	}

	for _, imp := range imports {
		f.WriteString("\t" + imp + "\n")
	}

	f.WriteString(")\n\n")

	// Generate events for each handler
	for _, handler := range handlers {
		// Skip if handler name is empty or doesn't start with 'Handle'
		if handler.Name == "" || !strings.HasPrefix(handler.Name, "Handle") {
			continue
		}

		// Generate the "Requested" event
		f.WriteString(fmt.Sprintf("// %sRequestedEvent is triggered when %s is requested.\n", handler.Name, handler.TrimmedName))
		f.WriteString("// Prevent default to skip the default behavior and return your own data.\n")
		f.WriteString(fmt.Sprintf("type %sRequestedEvent struct {\n", handler.Name))
		f.WriteString("\thook_resolver.Event\n")

		// Add path parameters
		for _, param := range handler.Api.Params {
			f.WriteString(fmt.Sprintf("\t%s %s `json:\"%s\"`\n", pascalCase(param.Name), param.GoType, param.JsonName))
		}

		// Add body fields
		for _, field := range handler.Api.BodyFields {
			goType := field.GoType
			if goType == "__STRUCT__" || goType == "[]__STRUCT__" || (strings.HasPrefix(goType, "map[") && strings.Contains(goType, "__STRUCT__")) {
				goType = field.InlineStructType
			}
			goType = strings.Replace(goType, "handlers.", "", 1)
			addPointer := isCustomStruct(goType)
			if addPointer {
				goType = "*" + goType
			}
			f.WriteString(fmt.Sprintf("\t%s %s `json:\"%s\"`\n", pascalCase(field.Name), goType, field.JsonName))
		}

		// If handler returns something other than bool or true, add a Data field to store the result
		if handler.Api.ReturnGoType != "" && handler.Api.ReturnGoType != "true" && handler.Api.ReturnGoType != "bool" {
			returnGoType := strings.Replace(handler.Api.ReturnGoType, "handlers.", "", 1)
			addPointer := isCustomStruct(returnGoType)
			if addPointer {
				returnGoType = "*" + returnGoType
			}
			f.WriteString(fmt.Sprintf("\t// Empty data object, will be used if the hook prevents the default behavior\n"))
			f.WriteString(fmt.Sprintf("\tData %s `json:\"data\"`\n", returnGoType))
		}

		f.WriteString("}\n\n")

		// Generate the response event if handler returns something other than bool or true
		if handler.Api.ReturnGoType != "" && handler.Api.ReturnGoType != "true" && handler.Api.ReturnGoType != "bool" {
			returnGoType := strings.Replace(handler.Api.ReturnGoType, "handlers.", "", 1)
			addPointer := isCustomStruct(returnGoType)
			if addPointer {
				returnGoType = "*" + returnGoType
			}
			f.WriteString(fmt.Sprintf("// %sEvent is triggered after processing %s.\n", handler.Name, handler.TrimmedName))
			f.WriteString(fmt.Sprintf("type %sEvent struct {\n", handler.Name))
			f.WriteString("\thook_resolver.Event\n")
			f.WriteString(fmt.Sprintf("\tData %s `json:\"data\"`\n", returnGoType))
			f.WriteString("}\n\n")
		}
	}

	cmd := exec.Command("gofmt", "-w", outFilePath)
	cmd.Run()
}

func pascalCase(s string) string {
	return strings.ReplaceAll(strings.Title(strings.ReplaceAll(s, "_", " ")), " ", "")
}
