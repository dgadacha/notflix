package torrentstream

import (
	"notflix/internal/database/db_bridge"
	"notflix/internal/events"
	hibiketorrent "notflix/internal/extension/hibike/torrent"
	"notflix/internal/util"

	"github.com/5rahim/habari"
)

type BatchHistoryResponse struct {
	Torrent           *hibiketorrent.AnimeTorrent      `json:"torrent"`
	Metadata          *habari.Metadata                 `json:"metadata"`
	BatchEpisodeFiles *hibiketorrent.BatchEpisodeFiles `json:"batchEpisodeFiles"`
}

func (r *Repository) GetBatchHistory(mId int) (ret *BatchHistoryResponse) {
	defer util.HandlePanicInModuleThen("torrentstream/GetBatchHistory", func() {
		ret = &BatchHistoryResponse{}
	})

	torrent, batchFiles, err := db_bridge.GetTorrentstreamHistory(r.db, mId)
	if err != nil {
		return &BatchHistoryResponse{}
	}

	metadata := habari.Parse(torrent.Name)

	return &BatchHistoryResponse{
		torrent,
		metadata,
		batchFiles,
	}
}

func (r *Repository) AddBatchHistory(mId int, torrent *hibiketorrent.AnimeTorrent, files *hibiketorrent.BatchEpisodeFiles) {
	go func() {
		defer util.HandlePanicInModuleThen("torrentstream/AddBatchHistory", func() {})

		_ = db_bridge.InsertTorrentstreamHistory(r.db, mId, torrent, files)

		r.wsEventManager.SendEvent(events.InvalidateQueries, []string{events.GetTorrentstreamBatchHistoryEndpoint})
	}()
}
