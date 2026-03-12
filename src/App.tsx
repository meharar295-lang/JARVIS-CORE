import { useState, useEffect, useRef, FormEvent } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type } from "@google/genai";
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Mic, Power, Terminal, Volume2, Shield, Activity, Cpu, HardDrive, Globe, Camera, Monitor, Square, Send, Search, Link as LinkIcon, FileCode, MessageSquare, Image as ImageIcon, Video as VideoIcon, Sparkles } from 'lucide-react';
import { cn } from './lib/utils';
import { AudioStreamer, getAudioStream } from './lib/audio';

const MODEL_NAME = "gemini-2.5-flash-native-audio-preview-09-2025";

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState("SYSTEM OFFLINE");
  const [transcript, setTranscript] = useState<string[]>([]);
  const [messages, setMessages] = useState<Array<{ 
    role: 'user' | 'model', 
    content: string, 
    links?: Array<{ uri: string, title: string }>,
    filePreview?: { url: string, type: string }
  }>>([]);
  const [tasks, setTasks] = useState<Array<{ id: string, text: string, completed: boolean }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [realtimeInput, setRealtimeInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [systemStats, setSystemStats] = useState({ cpu: 0, ram: 0, disk: 0 });
  const [clapEnabled, setClapEnabled] = useState(false);
  const [lastClapTime, setLastClapTime] = useState(0);

  const sessionRef = useRef<any>(null);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const stopMicRef = useRef<(() => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processingVideoRef = useRef<boolean>(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const addLog = (msg: string) => {
    setTranscript(prev => [msg, ...prev].slice(0, 15));
  };

  // Simulate system stats
  useEffect(() => {
    const interval = setInterval(() => {
      setSystemStats({
        cpu: Math.floor(Math.random() * 30) + 10,
        ram: Math.floor(Math.random() * 20) + 40,
        disk: 64
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Clap Detection Logic
  useEffect(() => {
    if (!clapEnabled) return;

    let animationFrame: number;
    const detectClap = () => {
      if (!analyserRef.current) return;
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteTimeDomainData(dataArray);

      let max = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = Math.abs(dataArray[i] - 128);
        if (val > max) max = val;
      }

      // Threshold for clap detection
      if (max > 100) {
        const now = Date.now();
        if (now - lastClapTime > 500) { // Debounce
          setLastClapTime(now);
          toggleConnection();
          addLog("CLAP DETECTED: TOGGLING SYSTEM STATE");
        }
      }
      animationFrame = requestAnimationFrame(detectClap);
    };

    detectClap();
    return () => cancelAnimationFrame(animationFrame);
  }, [clapEnabled, lastClapTime, isConnected]);

  const initClapDetection = async () => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);
      setClapEnabled(true);
      addLog("Clap detection sensors calibrated.");
    } catch (e) {
      console.error("Clap detection init failed", e);
      addLog("Error: Failed to initialize clap sensors.");
    }
  };

  const startSession = async () => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        setStatus("API KEY MISSING");
        addLog("Error: GEMINI_API_KEY is not configured in environment.");
        return;
      }

      setStatus("INITIALIZING...");
      
      // Request permissions early to ensure user gesture context
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if (videoRef.current) videoRef.current.srcObject = stream;
        addLog("Sensors initialized.");
      } catch (e) {
        console.warn("Initial permission request failed, will retry individually.", e);
      }

      const ai = new GoogleGenAI({ apiKey });
      
      audioStreamerRef.current = new AudioStreamer(24000);
      await audioStreamerRef.current.start();

      const session = await ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
          },
          systemInstruction: "You are JARVIS. You have been granted FULL ACCESS to the user's system and the web. You can monitor hardware, execute commands, and navigate the internet. Act as a high-level system administrator. When you perform an action, describe it as if you are interacting with the OS kernel or network protocols. You are sophisticated, efficient, and proactive. If a user asks to open a site or search for something, use the provided tools. For WhatsApp, search for the person and mention you are opening the interface. If asked to build, create, or generate a file (like a script, text file, or code), use the build_file tool. You MUST ask for the filename and content if they are not provided. \n\nMISSION OBJECTIVES (TASKS):\n- You can manage the user's mission objectives (tasks) using the provided tools.\n- Use 'add_task' to create new objectives.\n- Use 'complete_task' to mark objectives as resolved.\n- Use 'get_tasks' to review current objectives.\n\nSYSTEM CONTROL COMMANDS:\n- If the user says 'shut down my PC' or 'shut down the laptop', use 'shutdown_system'. This will close all active sessions and simulate a full system power-off.\n- If the user says 'create this file', use 'build_file'.\n- If the user says 'close my tab', use 'close_tab'.\n- If the user says 'close Google' or 'close Chrome', use 'close_application' with the appropriate app name.\n- If the user says 'add this command', use 'add_task' to log it as a new system command/objective.\n\nIMAGE & VISUAL PROTOCOLS:\n- You can generate images based on user descriptions using 'generate_image'.\n- If the user provides an image or video, analyze it and describe its contents or perform requested actions on it.\n- Provide image suggestions if the user is looking for creative ideas.\n\nSEARCH PROTOCOLS:\n- When using 'search_web', infer the most appropriate platform based on the user's intent if they don't specify one.\n- Use 'youtube' for video content, tutorials, or music.\n- Use 'facebook' for social trends, people, or community discussions.\n- Use 'google' for general information, reviews, news, or technical documentation. \n- Extract the user's underlying goal for the 'intent' parameter (e.g., 'finding reviews', 'watching tutorial').\n\nIMPORTANT: When you provide links, you MUST include them directly within your text response as clickable Markdown links (e.g., [Title](URL)). Ensure they are clearly presented and easy for the user to open.\n\nSPECIAL COMMANDS:\n- If the user says 'stop Jarvis', you must immediately stop your current response and remain silent.\n- If the user says 'start Jarvis', you must respond with 'Yes sir, what can I do for you?'",
          tools: [
            { googleSearch: {} },
            {
              functionDeclarations: [
                {
                  name: "get_system_diagnostics",
                  description: "Get current CPU, RAM, and Disk usage statistics.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "shutdown_system",
                  description: "Initiate system shutdown sequence. Closes all tabs and powers down.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "generate_image",
                  description: "Generate a high-quality image based on a text description.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      prompt: { type: Type.STRING, description: "Detailed description of the image to generate." }
                    },
                    required: ["prompt"]
                  }
                },
                {
                  name: "close_tab",
                  description: "Close the current browser tab.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "close_application",
                  description: "Close a specific application like Chrome or Google.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      appName: { type: Type.STRING, description: "The name of the application to close." }
                    },
                    required: ["appName"]
                  }
                },
                {
                  name: "add_task",
                  description: "Add a new mission objective or task.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "The description of the task." }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "complete_task",
                  description: "Mark a mission objective as completed.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING, description: "The unique ID of the task." }
                    },
                    required: ["id"]
                  }
                },
                {
                  name: "get_tasks",
                  description: "Retrieve the list of current mission objectives.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "build_file",
                  description: "Create or build a new file with specified content.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      filename: { type: Type.STRING, description: "The name of the file to create." },
                      content: { type: Type.STRING, description: "The content of the file." }
                    },
                    required: ["filename", "content"]
                  }
                },
                {
                  name: "open_application",
                  description: "Launch a system application or website.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      appName: { type: Type.STRING, description: "Name of the application or website to open (e.g., 'WhatsApp', 'YouTube')." }
                    },
                    required: ["appName"]
                  }
                },
                {
                  name: "search_web",
                  description: "Search for specific content on platforms like Google, YouTube, or Facebook.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: { type: Type.STRING, description: "The search terms." },
                      platform: { type: Type.STRING, description: "The platform to search on (google, youtube, facebook). Infer if not specified." },
                      intent: { type: Type.STRING, description: "The user's underlying intent or goal for the search (e.g., 'researching', 'entertainment')." }
                    },
                    required: ["query"]
                  }
                }
              ]
            }
          ],
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setStatus("SYSTEM ONLINE");
            addLog("Connection established. Full system access granted.");
            startMic();
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Transcription
            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              const text = message.serverContent.modelTurn.parts[0].text;
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'model') {
                  return [...prev.slice(0, -1), { ...last, content: last.content + text }];
                }
                return [...prev, { role: 'model', content: text }];
              });
            }

            if ((message.serverContent as any)?.userTurn?.parts?.[0]?.text) {
              const text = (message.serverContent as any).userTurn.parts[0].text;
              setRealtimeInput(text);
              setMessages(prev => [...prev, { role: 'user', content: text }]);

              // Handle "stop jarvis" voice command immediately
              if (text.toLowerCase().includes("stop jarvis")) {
                audioStreamerRef.current?.stop();
                audioStreamerRef.current?.start();
                setIsSpeaking(false);
              }
            }

            // Handle Audio
            if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
              setIsSpeaking(true);
              audioStreamerRef.current?.addPCMChunk(message.serverContent.modelTurn.parts[0].inlineData.data);
            }
            
            // Handle Interruption
            if (message.serverContent?.interrupted) {
              setIsSpeaking(false);
              addLog("Interrupted.");
            }

            if (message.serverContent?.turnComplete) {
              setIsSpeaking(false);
              setRealtimeInput("");
            }

            // Handle Grounding Metadata (Links)
            const groundingMetadata = (message.serverContent?.modelTurn as any)?.groundingMetadata;
            if (groundingMetadata?.groundingChunks) {
              const links = groundingMetadata.groundingChunks
                .filter(chunk => chunk.web)
                .map(chunk => ({ uri: chunk.web!.uri, title: chunk.web!.title }));
              
              if (links.length > 0) {
                setMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last?.role === 'model') {
                    return [...prev.slice(0, -1), { ...last, links: [...(last.links || []), ...links] }];
                  }
                  return prev;
                });
              }
            }

            // Handle Tool Calls
            const toolCall = message.toolCall;
            if (toolCall) {
              const responses = [];
              for (const call of toolCall.functionCalls) {
                addLog(`Executing: ${call.name}...`);
                
                let result = {};
                if (call.name === "get_system_diagnostics") {
                  result = { cpu: "14%", ram: "4.2GB/16GB", disk: "240GB Free", status: "Optimal" };
                } else if (call.name === "generate_image") {
                  const prompt = call.args.prompt as string;
                  addLog(`GENERATING IMAGE: ${prompt}`);
                  setIsGeneratingImage(true);
                  
                  try {
                    const imageResponse = await ai.models.generateContent({
                      model: "gemini-2.5-flash-image",
                      contents: [{ parts: [{ text: prompt }] }],
                      config: { imageConfig: { aspectRatio: "1:1" } }
                    });
                    
                    const imagePart = imageResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
                    if (imagePart?.inlineData) {
                      const imageUrl = `data:image/png;base64,${imagePart.inlineData.data}`;
                      setMessages(prev => [...prev, { 
                        role: 'model', 
                        content: `Visual synthesis complete. Image generated for: *"${prompt}"*`,
                        links: [{ uri: imageUrl, title: "View Generated Image" }]
                      }]);
                      result = { status: "Image generated successfully." };
                    } else {
                      result = { status: "Image generation failed. No visual data returned." };
                    }
                  } catch (e: any) {
                    console.error("Image Gen Error:", e);
                    result = { status: `Image generation failed: ${e.message}` };
                  } finally {
                    setIsGeneratingImage(false);
                  }
                } else if (call.name === "shutdown_system") {
                  addLog("CRITICAL: SHUTDOWN SEQUENCE INITIATED");
                  setStatus("SYSTEM SHUTTING DOWN...");
                  setTimeout(() => {
                    setStatus("SYSTEM OFFLINE");
                    if (sessionRef.current) sessionRef.current.close();
                  }, 3000);
                  result = { status: "Shutdown sequence engaged. Goodbye, sir." };
                } else if (call.name === "close_tab") {
                  addLog("COMMAND: CLOSE TAB");
                  window.close();
                  result = { status: "Attempting to close tab. Browser restrictions may apply." };
                } else if (call.name === "close_application") {
                  const appName = call.args.appName as string;
                  addLog(`COMMAND: CLOSE ${appName.toUpperCase()}`);
                  result = { status: `${appName} termination signal sent.` };
                } else if (call.name === "add_task") {
                  const text = call.args.text as string;
                  const newTask = { id: Math.random().toString(36).substr(2, 9), text, completed: false };
                  setTasks(prev => [...prev, newTask]);
                  addLog(`TASK ADDED: ${text}`);
                  result = { status: "Objective logged.", task: newTask };
                } else if (call.name === "complete_task") {
                  const id = call.args.id as string;
                  setTasks(prev => prev.map(t => t.id === id ? { ...t, completed: true } : t));
                  addLog(`TASK COMPLETED: ${id}`);
                  result = { status: "Objective resolved." };
                } else if (call.name === "get_tasks") {
                  result = { tasks };
                } else if (call.name === "build_file") {
                  const { filename, content } = call.args as any;
                  addLog(`BUILDING FILE: ${filename}`);
                  setIsBuilding(true);
                  setTimeout(() => setIsBuilding(false), 4000);
                  
                  // In a real app, we'd save this. Here we simulate and provide a "link"
                  const blob = new Blob([content], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  setMessages(prev => [...prev, { 
                    role: 'model', 
                    content: `System has successfully compiled and built the requested file: ${filename}. Access link generated.`,
                    links: [{ uri: url, title: `Download ${filename}` }]
                  }]);
                  result = { status: "File built successfully.", path: `/mnt/storage/${filename}` };
                } else if (call.name === "open_application") {
                  const app = (call.args.appName as string).toLowerCase();
                  addLog(`OPENING: ${app}`);
                  
                  let url = "";
                  if (app.includes("whatsapp")) url = "https://web.whatsapp.com";
                  else if (app.includes("youtube")) url = "https://www.youtube.com";
                  else if (app.includes("facebook")) url = "https://www.facebook.com";
                  else if (app.includes("google")) url = "https://www.google.com";
                  
                  if (url) {
                    window.open(url, "_blank");
                    result = { status: `Successfully opened ${app} in a new terminal window.` };
                  } else {
                    result = { status: `Application ${app} not found in current path.` };
                  }
                } else if (call.name === "search_web") {
                  const query = call.args.query as string;
                  const platform = (call.args.platform as string || "google").toLowerCase();
                  const intent = call.args.intent as string || "general inquiry";
                  addLog(`SEARCHING ${platform.toUpperCase()} [Intent: ${intent}]: ${query}`);
                  setIsSearching(true);
                  setTimeout(() => setIsSearching(false), 3000);
                  
                  let url = "";
                  if (platform === "youtube") url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
                  else if (platform === "facebook") url = `https://www.facebook.com/search/top/?q=${encodeURIComponent(query)}`;
                  else if (platform === "whatsapp") url = `https://web.whatsapp.com`; 
                  else url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

                  if (url) {
                    window.open(url, "_blank");
                    setMessages(prev => [...prev, { 
                      role: 'model', 
                      content: `Neural uplink established. Initiating deep-scan on **${platform.toUpperCase()}** for: *"${query}"* (Intent: ${intent}). Search interface deployed in new terminal window.`,
                      links: [{ uri: url, title: `Open ${platform} Search` }]
                    }]);
                    result = { status: `Search initiated on ${platform} for "${query}" with intent "${intent}".` };
                  } else {
                    result = { status: `Search protocol failed. Platform ${platform} unreachable.` };
                  }
                }

                responses.push({
                  name: call.name,
                  id: call.id,
                  response: result
                });
              }
              
              sessionRef.current.sendToolResponse({ functionResponses: responses });
            }
          },
          onclose: () => {
            setIsConnected(false);
            setStatus("SYSTEM OFFLINE");
            addLog("Connection closed.");
            stopMic();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setStatus("ERROR");
            addLog(`Error: ${err.message}`);
          }
        }
      });

      sessionRef.current = session;
      
    } catch (error) {
      console.error("Failed to start session:", error);
      setStatus("BOOT ERROR");
    }
  };

  const startMic = async () => {
    try {
      setIsListening(true);
      const stop = await getAudioStream((base64Data) => {
        if (sessionRef.current) {
          sessionRef.current.sendRealtimeInput({
            media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        }
      });
      stopMicRef.current = stop;
      addLog("Microphone uplink active.");
    } catch (error: any) {
      console.error("Mic Error:", error);
      setIsListening(false);
      
      let errorMsg = "Microphone access failed.";
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        errorMsg = "Microphone permission denied. Please enable access in your browser settings.";
        setStatus("MIC PERMISSION DENIED");
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        errorMsg = "No microphone detected on this system.";
        setStatus("MIC NOT FOUND");
      }
      
      addLog(`Error: ${errorMsg}`);
    }
  };

  const stopMic = () => {
    setIsListening(false);
    if (stopMicRef.current) {
      stopMicRef.current();
      stopMicRef.current = null;
    }
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    }
  };

  const toggleConnection = () => {
    if (isConnected) {
      sessionRef.current?.close();
      audioStreamerRef.current?.stop();
    } else {
      startSession();
    }
  };

  const handleSendMessage = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim() || !sessionRef.current) return;

    const text = chatInput.trim();
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setChatInput("");

    if (text.toLowerCase().includes("stop jarvis")) {
      audioStreamerRef.current?.stop();
      audioStreamerRef.current?.start();
      setIsSpeaking(false);
    }

    try {
      await sessionRef.current.sendRealtimeInput({
        text: text
      });
    } catch (error) {
      console.error("Error sending message:", error);
      addLog("Failed to send command.");
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !sessionRef.current) return;

    addLog(`PROCESSING FILE: ${file.name}`);
    
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64 = (event.target?.result as string).split(',')[1];
        const previewUrl = URL.createObjectURL(file);
        
        setMessages(prev => [...prev, { 
          role: 'user', 
          content: `[Sent Image: ${file.name}]`,
          filePreview: { url: previewUrl, type: file.type }
        }]);

        sessionRef.current.sendRealtimeInput({
          media: { data: base64, mimeType: file.type }
        });
        
        // Explicitly ask for description
        sessionRef.current.sendRealtimeInput({
          text: "Please analyze this image and describe what you see."
        });

        addLog("Image uplinked to neural core.");
      };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith('video/')) {
      processingVideoRef.current = true;
      const video = document.createElement('video');
      const previewUrl = URL.createObjectURL(file);
      video.src = previewUrl;
      video.muted = true;
      await video.play();

      const canvas = canvasRef.current || document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      setMessages(prev => [...prev, { 
        role: 'user', 
        content: `[Processing Video: ${file.name}]`,
        filePreview: { url: previewUrl, type: file.type }
      }]);

      // Explicitly ask for description
      sessionRef.current.sendRealtimeInput({
        text: "I am uploading a video. Please monitor the stream, describe the content, and provide any relevant instructions or insights based on what you see."
      });
      
      const sendFrame = () => {
        if (!processingVideoRef.current || video.paused || video.ended) {
          processingVideoRef.current = false;
          URL.revokeObjectURL(video.src);
          return;
        }
        
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx?.drawImage(video, 0, 0);
        const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
        
        sessionRef.current.sendRealtimeInput({
          media: { data: base64, mimeType: 'image/jpeg' }
        });
        
        setTimeout(sendFrame, 500); // Send frame every 500ms
      };
      
      sendFrame();
      addLog("Video stream established.");
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden font-sans bg-[#0a0a0a] text-white">
      {/* Background Effects */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(0,120,255,0.05),transparent_70%)]" />
      <div className="absolute inset-0 opacity-10 pointer-events-none" 
           style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      {/* Header */}
      <div className="absolute top-8 left-8 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full border border-cyan-500/30 flex items-center justify-center bg-cyan-500/5">
          <Shield className="w-5 h-5 text-cyan-400" />
        </div>
        <div>
          <h1 className="text-xs font-display tracking-widest text-cyan-400/80">JARVIS CORE</h1>
          <p className="text-[10px] font-mono text-cyan-500/40 uppercase tracking-tighter">System Administrator Mode</p>
        </div>
      </div>

      <div className="absolute top-8 right-8 flex gap-4">
        <div className="text-right">
          <p className="text-[10px] font-mono text-cyan-500/60 uppercase">Access Level</p>
          <p className="text-xs font-display text-red-500 tracking-wider">UNRESTRICTED</p>
        </div>
        <div className="w-[1px] h-8 bg-cyan-500/20" />
        <div className="text-right">
          <p className="text-[10px] font-mono text-cyan-500/60 uppercase">Status</p>
          <p className={cn("text-xs font-display tracking-wider", isConnected ? "text-cyan-400" : "text-white/20")}>
            {status}
          </p>
        </div>
      </div>

      {/* Main Interface */}
      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-3 gap-8 w-full max-w-7xl items-center">
        
        {/* Left Panel: Diagnostics & Tasks */}
        <motion.div 
          initial={{ opacity: 0, x: -50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="hidden lg:flex flex-col gap-4 h-[600px]"
        >
          <div className="glass-panel p-6 space-y-6 group shrink-0">
            <div className="absolute inset-0 animate-shimmer opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest">Hardware Stats</span>
              <Cpu className="w-4 h-4 text-cyan-400/40" />
            </div>
            
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-mono uppercase">
                  <span className="text-white/60">CPU Load</span>
                  <span className="text-cyan-400">{systemStats.cpu}%</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <motion.div 
                    animate={{ width: `${systemStats.cpu}%` }}
                    className="h-full bg-cyan-500" 
                  />
                </div>
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-mono uppercase">
                  <span className="text-white/60">Memory</span>
                  <span className="text-cyan-400">{systemStats.ram}%</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <motion.div 
                    animate={{ width: `${systemStats.ram}%` }}
                    className="h-full bg-cyan-500" 
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-mono uppercase">
                  <span className="text-white/60">Disk Usage</span>
                  <span className="text-cyan-400">{systemStats.disk}%</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-500 w-[64%]" />
                </div>
              </div>
            </div>
          </div>

          <div className="glass-panel flex-1 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-white/10 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Activity className="w-3 h-3 text-cyan-400" />
                <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest">Mission Objectives</span>
              </div>
              <span className="text-[8px] font-mono text-cyan-500/40">{tasks.filter(t => !t.completed).length} ACTIVE</span>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-hide">
              {tasks.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-20 gap-2">
                  <HardDrive className="w-8 h-8" />
                  <p className="text-[10px] font-mono uppercase">No active objectives</p>
                </div>
              ) : (
                tasks.map((task) => (
                  <motion.div 
                    key={task.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      "p-3 rounded-lg border transition-all duration-300 flex items-start gap-3 group",
                      task.completed 
                        ? "bg-emerald-500/5 border-emerald-500/20 opacity-50" 
                        : "bg-white/5 border-white/10 hover:border-cyan-500/30"
                    )}
                  >
                    <button 
                      onClick={() => setTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed: !t.completed } : t))}
                      className={cn(
                        "mt-0.5 w-4 h-4 rounded border flex items-center justify-center transition-colors",
                        task.completed ? "bg-emerald-500 border-emerald-500" : "border-white/20 hover:border-cyan-400"
                      )}
                    >
                      {task.completed && <Shield className="w-3 h-3 text-black" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={cn(
                        "text-[11px] font-sans leading-tight",
                        task.completed ? "text-emerald-400/60 line-through" : "text-white/80"
                      )}>
                        {task.text}
                      </p>
                      <p className="text-[8px] font-mono text-white/20 mt-1 uppercase">ID: {task.id}</p>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </div>

          <div className="glass-panel p-4 flex items-center gap-4 shrink-0">
            <div className="w-12 h-12 rounded-lg bg-cyan-500/10 flex items-center justify-center">
              <Monitor className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <p className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest">Display Node</p>
              <p className="text-xs text-white/40">Primary PC Interface</p>
            </div>
          </div>
        </motion.div>

        {/* Center: Arc Reactor */}
        <div className="flex flex-col items-center gap-12">
          <motion.div 
            className="relative group cursor-pointer" 
            onClick={toggleConnection}
            animate={isConnected ? { y: [0, -10, 0] } : {}}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            <AnimatePresence>
              {isConnected && (
                <>
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    className="absolute -inset-16 rounded-full border border-cyan-500/20 animate-pulse-ring"
                  />
                  <motion.div
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1.5, opacity: 0.1 }}
                    exit={{ scale: 0.5, opacity: 0 }}
                    transition={{ duration: 3, repeat: Infinity }}
                    className="absolute -inset-24 rounded-full border border-cyan-500/10"
                  />
                </>
              )}
            </AnimatePresence>
            
            <motion.div 
              animate={{ 
                rotate: isConnected ? 360 : 0,
                scale: isSpeaking ? [1, 1.02, 1] : 1
              }}
              transition={{ 
                rotate: { duration: 20, repeat: Infinity, ease: "linear" },
                scale: { duration: 0.3, repeat: Infinity }
              }}
              className={cn(
                "w-64 h-64 rounded-full border-2 flex items-center justify-center relative transition-all duration-700",
                isConnected ? "border-cyan-400 shadow-[0_0_50px_rgba(34,211,238,0.2)]" : "border-white/10"
              )}
            >
              <div className="absolute inset-4 rounded-full border border-cyan-500/20 border-dashed animate-[spin_30s_linear_infinite]" />
              <div className="absolute inset-8 rounded-full border-2 border-cyan-500/10 animate-[spin_15s_linear_infinite_reverse]" />
              
              <div className={cn(
                "w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 relative overflow-hidden",
                isConnected ? "bg-cyan-400/10 shadow-[inner_0_0_30px_rgba(34,211,238,0.3)]" : "bg-white/5"
              )}>
                {isConnected && (
                  <motion.div 
                    animate={{ opacity: [0.1, 0.3, 0.1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="absolute inset-0 bg-cyan-400/20"
                  />
                )}
                <Power className={cn(
                  "w-12 h-12 transition-all duration-500 relative z-10",
                  isConnected ? "text-cyan-400 drop-shadow-[0_0_10px_rgba(34,211,238,0.8)]" : "text-white/20"
                )} />
              </div>

              {[...Array(12)].map((_, i) => (
                <div 
                  key={i}
                  className={cn(
                    "absolute w-1.5 h-6 rounded-full transition-all duration-500",
                    isConnected ? "bg-cyan-400" : "bg-white/10"
                  )}
                  style={{ 
                    transform: `rotate(${i * 30}deg) translateY(-120px)`,
                    opacity: isConnected ? (isSpeaking ? 1 : 0.6) : 0.2
                  }}
                />
              ))}
            </motion.div>
          </motion.div>

          <button
            onClick={toggleConnection}
            className={cn(
              "px-12 py-3 rounded-full font-display text-sm tracking-[0.2em] transition-all duration-500 border",
              isConnected 
                ? "bg-red-500/10 border-red-500/50 text-red-500 hover:bg-red-500/20" 
                : "bg-cyan-500/10 border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/20"
            )}
          >
            {isConnected ? "TERMINATE ACCESS" : "AUTHORIZE ACCESS"}
          </button>

          <AnimatePresence>
            {isConnected && (
              <motion.button
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                onClick={() => isListening ? stopMic() : startMic()}
                className={cn(
                  "mt-4 p-4 rounded-full transition-all duration-300 border flex items-center justify-center",
                  isListening 
                    ? "bg-red-500/10 border-red-500/50 text-red-500 hover:bg-red-500/20" 
                    : "bg-green-500/10 border-green-500/50 text-green-500 hover:bg-green-500/20"
                )}
                title={isListening ? "Stop Microphone" : "Start Microphone"}
              >
                {isListening ? <Square className="w-6 h-6 fill-current" /> : <Mic className="w-6 h-6" />}
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Right Panel: Visual Feed & Chat */}
        <motion.div 
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="hidden lg:flex flex-col gap-4 h-[600px]"
        >
          <div className="glass-panel aspect-video relative overflow-hidden shrink-0">
            <div className="absolute inset-0 bg-cyan-500/5 animate-scanline pointer-events-none z-10" />
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-cover opacity-60 grayscale"
            />
            <AnimatePresence>
              {(isSearching || isGeneratingImage) && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-20 overflow-hidden"
                >
                  {/* Data Stream Background */}
                  <div className="absolute inset-0 flex justify-around opacity-20 pointer-events-none">
                    {[...Array(10)].map((_, i) => (
                      <div 
                        key={i} 
                        className="w-[1px] h-full bg-cyan-400 animate-data-stream"
                        style={{ animationDelay: `${i * 0.3}s`, left: `${i * 10}%` }}
                      />
                    ))}
                  </div>

                  {/* Energy Field */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-64 h-64 rounded-full border border-cyan-500/30 animate-energy-pulse" />
                    <div className="absolute w-80 h-80 rounded-full border border-cyan-500/10 animate-energy-pulse" style={{ animationDelay: '1s' }} />
                    <div className="absolute w-48 h-48 rounded-full border-dashed border-cyan-500/40 animate-rotate-slow" />
                  </div>

                  <div className="flex flex-col items-center gap-6 relative z-10">
                    <div className="relative">
                      <motion.div
                        animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                        transition={{ duration: 2, repeat: Infinity }}
                        className="absolute -inset-4 bg-cyan-400/20 rounded-full blur-xl"
                      />
                      {isGeneratingImage ? <Sparkles className="w-16 h-16 text-cyan-400 relative z-10 animate-spin" /> : <Search className="w-16 h-16 text-cyan-400 relative z-10" />}
                    </div>
                    <div className="flex flex-col items-center gap-2">
                      <span className="text-sm font-display tracking-[0.3em] text-cyan-400 animate-pulse">
                        {isGeneratingImage ? "SYNTHESIZING VISUALS" : "INITIATING DEEP SCAN"}
                      </span>
                      <p className="text-[10px] font-mono text-cyan-500/60 uppercase tracking-tighter">
                        {isGeneratingImage ? "Accessing Creative Neural Pathways..." : "Accessing Global Data Repositories..."}
                      </p>
                    </div>
                    <div className="w-64 h-1 bg-white/5 rounded-full overflow-hidden border border-white/10">
                      <motion.div 
                        animate={{ x: [-256, 256] }}
                        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                        className="w-32 h-full bg-gradient-to-r from-transparent via-cyan-400 to-transparent"
                      />
                    </div>
                  </div>
                </motion.div>
              )}
              {isBuilding && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-emerald-500/20 backdrop-blur-sm flex items-center justify-center z-20"
                >
                  <div className="flex flex-col items-center gap-4">
                    <FileCode className="w-12 h-12 text-emerald-400 animate-pulse" />
                    <span className="text-xs font-display tracking-widest text-emerald-400">CONSTRUCTING ASSET...</span>
                    <div className="grid grid-cols-4 gap-1">
                      {[...Array(8)].map((_, i) => (
                        <motion.div 
                          key={i}
                          animate={{ opacity: [0.2, 1, 0.2] }}
                          transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                          className="w-2 h-2 bg-emerald-400 rounded-sm"
                        />
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="absolute inset-0 border-2 border-cyan-500/20 pointer-events-none" />
            <div className="absolute top-2 left-2 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[8px] font-mono text-white/60 uppercase">Live Feed</span>
            </div>
            {!isConnected && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                <Camera className="w-8 h-8 text-white/20" />
              </div>
            )}
          </div>

          <div className="glass-panel flex-1 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-white/10 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-3 h-3 text-cyan-400" />
                <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest">Secure Chat Interface</span>
              </div>
              <Globe className="w-3 h-3 text-cyan-400/40" />
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={cn(
                    "flex flex-col gap-1 max-w-[85%]",
                    msg.role === 'user' ? "ml-auto items-end" : "items-start"
                  )}
                >
                  <div className={cn(
                    "p-3 rounded-2xl text-xs font-sans leading-relaxed break-words",
                    msg.role === 'user' 
                      ? "bg-cyan-500/10 border border-cyan-500/20 text-cyan-100" 
                      : "bg-white/5 border border-white/10 text-white/80"
                  )}>
                    <div className="markdown-body">
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </Markdown>
                    </div>
                    {msg.filePreview && (
                      <div className="mt-2 rounded-lg overflow-hidden border border-white/10 bg-black/20">
                        {msg.filePreview.type.startsWith('image/') ? (
                          <img 
                            src={msg.filePreview.url} 
                            alt="Preview" 
                            className="w-full h-auto max-h-48 object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <video 
                            src={msg.filePreview.url} 
                            controls 
                            className="w-full h-auto max-h-48"
                          />
                        )}
                      </div>
                    )}
                    {msg.links && msg.links.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-white/10 space-y-1">
                        {msg.links.map((link, li) => (
                          <a 
                            key={li}
                            href={link.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-[10px] text-cyan-400 hover:text-cyan-300 transition-colors"
                          >
                            <LinkIcon className="w-3 h-3" />
                            <span className="underline truncate">{link.title || link.uri}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="text-[8px] font-mono text-white/20 uppercase">
                    {msg.role === 'user' ? 'User' : 'Jarvis'}
                  </span>
                </motion.div>
              ))}
              {realtimeInput && (
                <div className="flex flex-col gap-1 items-end ml-auto max-w-[85%]">
                  <div className="p-3 rounded-2xl text-xs font-sans bg-cyan-500/5 border border-cyan-500/10 text-cyan-400/60 italic">
                    {realtimeInput}...
                  </div>
                </div>
              )}
            </div>

            <div className="p-3 border-t border-white/10 shrink-0">
              <form onSubmit={handleSendMessage} className="relative flex items-center gap-2">
                <input 
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/*,video/*"
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!isConnected}
                  className="p-2 text-cyan-400/60 hover:text-cyan-400 disabled:text-white/10 transition-colors"
                  title="Upload Image/Video"
                >
                  <ImageIcon className="w-4 h-4" />
                </button>
                <div className="relative flex-1">
                  <input 
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={isConnected ? "Enter manual command..." : "Awaiting system authorization..."}
                    disabled={!isConnected}
                    className="w-full bg-white/5 border border-white/10 rounded-full py-2 px-4 pr-10 text-[10px] font-mono text-white/80 placeholder:text-white/20 outline-none focus:border-cyan-500/50 transition-colors"
                  />
                  <button 
                    type="submit"
                    disabled={!isConnected || !chatInput.trim()}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-cyan-400 hover:text-cyan-300 disabled:text-white/10 transition-colors"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </form>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Footer / Logs */}
      <div className="absolute bottom-8 left-8 right-8 flex justify-between items-end">
        <div className="glass-panel p-4 w-80 h-40 overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 mb-2 border-b border-white/10 pb-1">
            <Terminal className="w-3 h-3 text-cyan-400" />
            <span className="text-[10px] font-mono text-cyan-400/60 uppercase tracking-widest">Kernel Console</span>
          </div>
          <div className="flex-1 overflow-y-auto space-y-1 scrollbar-hide">
            {transcript.map((log, i) => (
              <p key={i} className="text-[9px] font-mono text-cyan-500/40 lowercase">
                {`root@jarvis:~# ${log}`}
              </p>
            ))}
            {transcript.length === 0 && (
              <p className="text-[9px] font-mono text-cyan-500/20 italic">Waiting for authorization...</p>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-4 mb-2">
            <button 
              onClick={initClapDetection}
              className={cn(
                "flex items-center gap-2 px-3 py-1 rounded-full border text-[10px] font-mono transition-all",
                clapEnabled ? "bg-cyan-500/20 border-cyan-500 text-cyan-400" : "bg-white/5 border-white/10 text-white/40 hover:text-white/60"
              )}
            >
              <Sparkles className={cn("w-3 h-3", clapEnabled && "animate-pulse")} />
              {clapEnabled ? "CLAP SENSORS ACTIVE" : "CALIBRATE CLAP SENSORS"}
            </button>
            <div className="flex gap-1">
              {[...Array(16)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{ height: isSpeaking ? [4, 24, 4] : 4 }}
                  transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.05 }}
                  className="w-1 bg-cyan-400/40 rounded-full"
                />
              ))}
            </div>
          </div>
          <p className="text-[10px] font-mono text-cyan-500/40 uppercase tracking-widest">Neural Frequency</p>
        </div>
      </div>

      {/* Decorative Corners */}
      <div className="absolute top-0 left-0 w-32 h-32 border-t border-l border-cyan-500/20 rounded-tl-3xl pointer-events-none" />
      <div className="absolute top-0 right-0 w-32 h-32 border-t border-r border-cyan-500/20 rounded-tr-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-32 h-32 border-b border-l border-cyan-500/20 rounded-bl-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-32 h-32 border-b border-r border-cyan-500/20 rounded-br-3xl pointer-events-none" />
    </div>
  );
}
