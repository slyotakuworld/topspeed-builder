import { AIGenerationService } from "./aiService";
import { GenerationHistoryService } from "./generationHistoryService";
import { GenerationService } from "./generationService";
import { ImageProcessingService } from "./imageService";
import { ProjectService } from "./projectService";
import { PromptAssistantService } from "./promptAssistantService";
import { ReferenceService } from "./referenceService";
import { SettingsService } from "./settingsService";
import { getUserDataDir } from "./utils";

/**
 * 全部业务服务的集合。GUI（Electron 主进程）、MCP server、CLI 三者共用同一套服务实现，
 * 保证出图 / 切图逻辑只有一份，不会因入口不同而行为分裂。
 */
export interface Services {
  settingsService: SettingsService;
  projectService: ProjectService;
  referenceService: ReferenceService;
  aiService: AIGenerationService;
  imageService: ImageProcessingService;
  historyService: GenerationHistoryService;
  generationService: GenerationService;
  promptAssistantService: PromptAssistantService;
}

/**
 * 构建完整服务集合。
 * @param userDataDir 可选：配置（settings.json）落盘目录。省略时：
 *   - Electron 运行时回退到 app.getPath("userData")（与 GUI 共享配置）；
 *   - 独立 Node 进程（CLI / MCP）回退到 env.TOPSPEED_USER_DATA 或 ~/.topspeed-builder。
 */
export function createServices(userDataDir?: string): Services {
  const settingsService = new SettingsService(userDataDir ?? getUserDataDir());
  const projectService = new ProjectService(settingsService);
  const referenceService = new ReferenceService();
  const aiService = new AIGenerationService();
  const imageService = new ImageProcessingService();
  const historyService = new GenerationHistoryService();
  const generationService = new GenerationService(
    settingsService,
    projectService,
    aiService,
    imageService,
    historyService
  );
  const promptAssistantService = new PromptAssistantService();
  return {
    settingsService,
    projectService,
    referenceService,
    aiService,
    imageService,
    historyService,
    generationService,
    promptAssistantService
  };
}
