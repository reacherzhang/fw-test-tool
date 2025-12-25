
import { GoogleGenAI, Type } from "@google/genai";
import { Device, AnalysisReport } from "../types";

/**
 * 针对单个设备的深度报告
 * Generates a deep diagnostic report for a single device using Gemini 3 Pro reasoning.
 */
export const generateDeviceReport = async (device: Device): Promise<AnalysisReport> => {
  // @google/genai Guidelines: Create a new GoogleGenAI instance right before making an API call.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const recentTelemetry = device.telemetry.slice(-30);
  const prompt = `
    You are a Senior IoT Diagnostics AI. Analyze this specific device's telemetry and config.
    Device: ${device.name} (${device.type})
    Context: Protocol ${device.protocol}, Connection ${device.connectionType}
    Data: ${JSON.stringify(recentTelemetry)}
    
    Task: Identify patterns, potential hardware fatigue, or protocol inconsistencies.
    Output must be in JSON format matching the schema provided.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: prompt,
      config: {
        // @google/genai Guidelines: Set both maxOutputTokens and thinkingConfig.thinkingBudget at the same time.
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 4000 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            anomalies: { type: Type.ARRAY, items: { type: Type.STRING } },
            recommendations: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["summary", "anomalies", "recommendations"]
        }
      }
    });

    // @google/genai Guidelines: Use response.text property (not a method).
    const text = response.text || "{}";
    return JSON.parse(text);
  } catch (error) {
    console.error("Diagnosis Error:", error);
    return {
      generatedAt: new Date().toISOString(),
      summary: "AI 诊断引擎暂时离线，请检查 API 配置。",
      anomalies: ["Connection Timeout"],
      recommendations: ["Retry Analysis"]
    };
  }
};

/**
 * 针对整个设备集群的系统级诊断
 * Analyzes fleet health to detect systemic protocol failures or bottlenecks.
 */
export const analyzeFleetHealth = async (devices: Device[]) => {
  // @google/genai Guidelines: Create a new GoogleGenAI instance right before making an API call.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const fleetSummary = devices.map(d => ({
    name: d.name,
    status: d.status,
    lastSeen: d.lastSeen,
    avgCpu: d.telemetry.reduce((acc, t) => acc + t.cpuLoad, 0) / (d.telemetry.length || 1)
  }));

  const prompt = `Analyze the health of this IoT fleet. Detect if there are systemic issues (e.g., a specific protocol failing, or a gateway bottleneck).
  Fleet Data: ${JSON.stringify(fleetSummary)}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: prompt,
      config: {
        // @google/genai Guidelines: Set both maxOutputTokens and thinkingConfig.thinkingBudget at the same time.
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 2000 }
      }
    });
    // @google/genai Guidelines: Use response.text property (not a method).
    return response.text || "无法获取集群诊断报告。";
  } catch (e) {
    return "无法获取集群诊断报告。";
  }
};
