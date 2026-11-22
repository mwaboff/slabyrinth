/** Home-screen thumbnails, drawn through the image bridge (best effort, once plan changes settle). */
import type { ImageBridge } from "../services/imageBridge";
import type { ProjectService } from "../services/projectService";

/** Quiet time after the last plan change before the thumbnail is redrawn. */
const THUMBNAIL_SETTLE_MS = 3000;
/** Largest side of a thumbnail, in pixels. */
const THUMBNAIL_MAX_PX = 320;

/** What runs after each plan change: schedules a redraw of the open project's thumbnail. */
export function thumbnailRefresher(projects: ProjectService, imageBridge: ImageBridge): () => void {
  let thumbTimer: NodeJS.Timeout | null = null;
  return () => {
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      const target = projects.thumbnailTarget();
      if (!target) return;
      const projectId = projects.getProject()?.id;
      imageBridge
        .request({
          level: target.levelId,
          showIds: false,
          planVersion: target.version,
          maxPx: THUMBNAIL_MAX_PX,
        })
        .then((png) => {
          if (projects.getProject()?.id === projectId)
            projects.setThumbnail(target.levelId, target.version, png);
        })
        .catch(() => undefined);
    }, THUMBNAIL_SETTLE_MS);
  };
}
