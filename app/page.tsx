"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import "./globals.css";

type Chat = { type: "user" | "group"; id: string | number; name: string };
type Contact = {
  phone_number: string;
  display_name?: string | null;
  nickname?: string | null;
  is_online?: boolean;
  avatar_url?: string | null;
};
type Group = { id: string | number; name: string; members: string[] };
type Message = {
  id: string | number;
  user: string;
  content: string;
  timestamp: string;
  group_id?: string | number;
  group_name?: string;
  receiver_phone?: string;
  target_user?: string;
  is_read?: boolean;
  is_deleted?: boolean;
  edited_at?: string;
};
type GroupedMessage = ({ type: "divider"; label: string } | ({ type: "msg" } & Message));
type CallState = "idle" | "incoming" | "calling" | "connected";
type ApiOptions = RequestInit & { headers?: HeadersInit };

type CallLogEntry = {
  id: string;
  peer: string;
  direction: "incoming" | "outgoing";
  media: "audio" | "video";
  status: "completed" | "missed" | "rejected";
  timestamp: string;
  duration: number;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Request failed";

const API = process.env.NEXT_PUBLIC_API_URL || "https://pratik0165-cipherbackend.hf.space";
const WS = process.env.NEXT_PUBLIC_WS_URL || API.replace(/^http/, "ws");

export default function PulseChat() {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [token, setToken] = useState(() => (typeof window === "undefined" ? "" : localStorage.getItem("chat_token") || ""));
  const [currentUser, setCurrentUser] = useState(() => (typeof window === "undefined" ? "" : localStorage.getItem("chat_user") || ""));

  const [profile, setProfile] = useState({ displayName: "", avatarUrl: "" });

  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const isAuth = !!token;

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.body.classList.toggle("auth-mode", !isAuth);
    }
  }, [isAuth]);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMsg, setInputMsg] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});

  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [typingSet, setTypingSet] = useState<Set<string>>(new Set());

  const [showEmojis, setShowEmojis] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showCallLogUI, setShowCallLogUI] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showNewContact, setShowNewContact] = useState(false);
  const [newContactPhone, setNewContactPhone] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [callState, setCallState] = useState<CallState>("idle");
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [callPeer, setCallPeer] = useState<string | null>(null);
  const [viewFile, setViewFile] = useState<{ url: string; type: string } | null>(null);

  const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);

  const [showHeaderNicknameEdit, setShowHeaderNicknameEdit] = useState(false);
  const [headerNicknameValue, setHeaderNicknameValue] = useState("");
  const [showContactProfile, setShowContactProfile] = useState(false);

  const [nicknames, setNicknames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!currentUser) return;
    try {
      const saved = localStorage.getItem(`nicknames_${currentUser}`);
      setNicknames(saved ? JSON.parse(saved) : {});
    } catch {
      setNicknames({});
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) {
      const savedLogs = localStorage.getItem(`call_logs_${currentUser}`);
      if (savedLogs) setCallLogs(JSON.parse(savedLogs));
    }
  }, [currentUser]);

  const msgListRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryDelay = useRef(1000);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pendingRemoteDescriptionRef = useRef<RTCSessionDescriptionInit | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const messagesCache = useRef<Record<string, Message[]>>({});
  
  // NEW: Queue to hold ICE candidates received before the connection is ready
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);

  const callStateRef = useRef<CallState>("idle");
  const callStartTimeRef = useRef<number | null>(null);
  const callDirectionRef = useRef<"incoming" | "outgoing" | null>(null);

  const updateCallState = useCallback((newState: CallState) => {
    setCallState(newState);
    callStateRef.current = newState;
  }, []);

  const emojis = ["😀", "😂", "🥰", "😎", "🤔", "😭", "😡", "👍", "❤️", "🔥", "🎉", "🚀", "✅", "💯", "🙏", "🫡", "😤", "🤩", "💀", "🫶"];
  const PAGE = 50;

  const isTyping = useMemo(() => activeChat?.type === "user" && typingSet.has(String(activeChat.id)), [activeChat, typingSet]);

  const apiFetch = useCallback(async <T,>(path: string, opts: ApiOptions = {}): Promise<T> => {
    const headers = new Headers(opts.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    headers.set("ngrok-skip-browser-warning", "true");
    const currentToken = token || (typeof window !== "undefined" ? localStorage.getItem("chat_token") : "");
    if (currentToken) headers.set("Authorization", `Bearer ${currentToken}`);
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: "Request failed" }));
      throw new Error(body.detail || "Request failed");
    }
    return res.json();
  }, [token]);

  const loadProfile = useCallback(async () => {
    try {
      const data = await apiFetch<{ display_name: string, avatar_url: string }>("/profile/me");
      setProfile({ displayName: data.display_name || "", avatarUrl: data.avatar_url || "" });
      setEditDisplayName(data.display_name || "");
    } catch { }
  }, [apiFetch]);

  const loadContacts = useCallback(async () => {
    try { setContacts(await apiFetch<Contact[]>("/contacts")); } catch { }
  }, [apiFetch]);

  const loadGroups = useCallback(async () => {
    try { setGroups(await apiFetch<Group[]>("/groups")); } catch { }
  }, [apiFetch]);

  const scrollBottom = () => {
    if (msgListRef.current) msgListRef.current.scrollTop = msgListRef.current.scrollHeight;
  };

  const loadHistory = async (chat: Chat, beforeId: string | number | null = null) => {
    if (!chat) return;
    setLoadingMore(true);
    try {
      const { type, id } = chat;
      const base = type === "user" ? `/messages/direct/${encodeURIComponent(id)}` : `/messages/group/${id}`;
      const history = await apiFetch<Message[]>(base + (beforeId ? `?before_id=${beforeId}` : ""));

      if (beforeId) {
        setMessages(prev => {
          const next = [...history, ...prev];
          messagesCache.current[chat.id] = next;
          return next;
        });
      } else {
        setMessages(history);
        messagesCache.current[chat.id] = history;
        setTimeout(scrollBottom, 100);
      }
      setHasMore(history.length === PAGE);
    } catch { }
    setLoadingMore(false);
  };

  const notify = (title: string, body: string) => {
    if (typeof window === "undefined" || Notification.permission !== "granted" || document.hasFocus()) return;
    const n = new Notification(title, { body });
    setTimeout(() => n.close(), 5000);
  };

  const endCall = useCallback((sendSignal = true, explicitStatus?: "completed" | "missed" | "rejected") => {
    if (callPeer && callDirectionRef.current) {
      const duration = callStartTimeRef.current && callStateRef.current === "connected"
        ? Math.floor((Date.now() - callStartTimeRef.current) / 1000)
        : 0;
      const finalStatus = explicitStatus || (callStateRef.current === "connected" ? "completed" : "missed");

      const newLog: CallLogEntry = {
        id: Date.now().toString() + Math.random().toString(),
        peer: callPeer,
        direction: callDirectionRef.current,
        media: isVideoCall ? "video" : "audio",
        status: finalStatus,
        timestamp: new Date().toISOString(),
        duration
      };

      setCallLogs(prev => {
        const next = [newLog, ...prev];
        if (currentUser) localStorage.setItem(`call_logs_${currentUser}`, JSON.stringify(next));
        return next;
      });
    }

    if (sendSignal && callPeer && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call_end", target_user: callPeer }));
    }
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    peerConnectionRef.current = null;
    pendingRemoteDescriptionRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    iceCandidateQueueRef.current = []; // Clear the ICE queue
    updateCallState("idle");
    setCallPeer(null);

    callStartTimeRef.current = null;
    callDirectionRef.current = null;
  }, [callPeer, isVideoCall, updateCallState, currentUser]);

  const initWSRef = useRef<(() => void) | null>(null);

  const initWS = useCallback(() => {
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (!token) return;

    const ws = new WebSocket(`${WS}/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => { wsRetryDelay.current = 1000; };
    ws.onclose = () => {
      if (!token) return;
      setTimeout(() => {
        wsRetryDelay.current = Math.min(wsRetryDelay.current * 2, 30000);
        initWSRef.current?.();
      }, wsRetryDelay.current);
    };

    ws.onmessage = async ({ data: raw }) => {
      let data: Partial<Message> & Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { return; }

      switch (data.type) {
        case "typing":
          if (typeof data.user === "string" && data.user !== currentUser) {
            setTypingSet(prev => new Set(prev).add(data.user as string));
            setTimeout(() => {
              setTypingSet(prev => { const next = new Set(prev); next.delete(data.user as string); return next; });
            }, 2000);
          }
          break;
        case "direct_message": {
          setTypingSet(prev => { const next = new Set(prev); next.delete(String(data.user)); return next; });
          const peer = data.user === currentUser ? (data.receiver_phone || data.target_user) : data.user;
          if (!peer) break;
          const msg = data as Message;

          setContacts(prev => prev.find(c => c.phone_number === peer) ? prev : [...prev, { phone_number: String(peer), display_name: null, is_online: false }]);

          setActiveChat(currentActive => {
            if (currentActive?.type === "user" && currentActive.id === peer) {
              setMessages(prev => {
                let next = prev;
                if (data.user === currentUser) {
                  const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
                  if (idx !== -1) {
                    next = [...prev];
                    next[idx] = msg;
                  } else if (!prev.find(m => m.id === msg.id)) {
                    next = [...prev, msg];
                  }
                } else if (!prev.find(m => m.id === msg.id)) {
                  next = [...prev, msg];
                }
                messagesCache.current[peer] = next;
                return next;
              });
              setTimeout(scrollBottom, 50);
              if (data.user !== currentUser && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "read_receipt", target_user: peer }));
              }
            } else if (data.user !== currentUser) {
              setUnread(prev => ({ ...prev, [String(peer)]: (prev[String(peer)] || 0) + 1 }));
              notify(String(data.user), msg.content);
            }
            return currentActive;
          });
          break;
        }
        case "group_message": {
          setActiveChat(currentActive => {
            if (currentActive?.type === "group" && currentActive.id === data.group_id) {
              setMessages(prev => {
                let next = prev;
                const msg = data as Message;
                if (data.user === currentUser) {
                  const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
                  if (idx !== -1) {
                    next = [...prev];
                    next[idx] = msg;
                  } else if (!prev.find(m => m.id === msg.id)) {
                    next = [...prev, msg];
                  }
                } else if (!prev.find(m => m.id === msg.id)) {
                  next = [...prev, msg];
                }
                messagesCache.current[data.group_id as string | number] = next;
                return next;
              });
              setTimeout(scrollBottom, 50);
            } else if (data.user !== currentUser) {
              setUnread(prev => ({ ...prev, [String(data.group_id)]: (prev[String(data.group_id)] || 0) + 1 }));
              notify(`${data.group_name}`, `${data.user}: ${data.content}`);
            }
            return currentActive;
          });
          break;
        }
        case "read_receipt":
          setMessages(prev => prev.map(m => m.user === currentUser ? { ...m, is_read: true } : m));
          break;
        case "message_edited": {
          setActiveChat(currentActive => {
            setMessages(prev => prev.map(m => m.id === data.id ? { ...m, content: String(data.content || ""), edited_at: data.edited_at } : m));
            return currentActive;
          });
          break;
        }
        case "message_deleted":
          setMessages(prev => prev.map(m => m.id === data.id ? { ...m, is_deleted: true } : m));
          break;
        case "presence":
          setContacts(prev => prev.map(c => c.phone_number === data.user ? { ...c, is_online: Boolean(data.online) } : c));
          break;

        case "call_offer":
          iceCandidateQueueRef.current = []; // Clear queue for new incoming call
          setCallPeer(String(data.user || ""));
          setIsVideoCall(Boolean(data.isVideo));
          updateCallState("incoming");
          callDirectionRef.current = "incoming";
          pendingRemoteDescriptionRef.current = data.sdp as RTCSessionDescriptionInit;
          break;
        case "call_answer":
          if (peerConnectionRef.current) {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit));
            updateCallState("connected");
            callStartTimeRef.current = Date.now();
            
            // Process any ICE candidates that were queued while creating the connection
            while (iceCandidateQueueRef.current.length > 0) {
              const candidate = iceCandidateQueueRef.current.shift();
              if (candidate) {
                await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
              }
            }
          }
          break;
        case "ice_candidate":
          // Only add candidate directly if remote description is already set.
          // Otherwise, push it to the queue.
          if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate as RTCIceCandidateInit)).catch(console.error);
          } else {
            iceCandidateQueueRef.current.push(data.candidate as RTCIceCandidateInit);
          }
          break;
        case "call_end":
          endCall(false);
          break;
        case "call_reject":
          endCall(false, "rejected");
          break;
      }
    };
  }, [token, currentUser, endCall, updateCallState]);

  useEffect(() => {
    initWSRef.current = initWS;
  }, [initWS]);

  useEffect(() => {
    if (token) {
      (async () => {
        await Promise.all([loadProfile(), loadContacts(), loadGroups()]);
        initWS();
      })();
    }
    return () => {
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [token, loadProfile, loadContacts, loadGroups, initWS]);

  const sendOTP = async () => {
    setAuthError(""); setAuthLoading(true);
    try {
      await apiFetch<void>("/auth/send-otp", { method: "POST", body: JSON.stringify({ phone_number: phoneNumber.trim() }) });
      setOtpSent(true);
    } catch (e) { setAuthError(errorMessage(e)); }
    finally { setAuthLoading(false); }
  };

  const verifyOTP = async () => {
    setAuthError(""); setAuthLoading(true);
    try {
      const data = await apiFetch<{ access_token: string }>("/auth/verify-otp", {
        method: "POST",
        body: JSON.stringify({ phone_number: phoneNumber.trim(), otp: otp.trim() })
      });
      setToken(data.access_token);
      setCurrentUser(phoneNumber.trim());
      localStorage.setItem("chat_token", data.access_token);
      localStorage.setItem("chat_user", phoneNumber.trim());

      if ("Notification" in window) Notification.requestPermission();
    } catch (e) { setAuthError(errorMessage(e)); }
    finally { setAuthLoading(false); }
  };

  const logout = () => {
    setToken(""); setCurrentUser(""); setOtpSent(false);
    setMessages([]); setActiveChat(null); setContacts([]); setGroups([]); setUnread({});
    setProfile({ displayName: "", avatarUrl: "" });
    setNicknames({});
    setShowHeaderNicknameEdit(false);
    setShowContactProfile(false);
    localStorage.removeItem("chat_token"); localStorage.removeItem("chat_user");
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingAvatar(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      await apiFetch("/profile/me", { method: "PATCH", body: JSON.stringify({ avatar_url: data.url }) });
      setProfile(prev => ({ ...prev, avatarUrl: data.url }));
    } catch {
      alert("Avatar upload failed");
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const saveProfile = async () => {
    try {
      await apiFetch("/profile/me", { method: "PATCH", body: JSON.stringify({ display_name: editDisplayName }) });
      setProfile(prev => ({ ...prev, displayName: editDisplayName }));
      setShowProfile(false);
    } catch {
      alert("Failed to save profile");
    }
  };

  const saveContactNickname = (phone: string, nickname: string) => {
    const trimmed = nickname.trim();
    setNicknames(prev => {
      const next = { ...prev };
      if (trimmed) {
        next[phone] = trimmed;
      } else {
        delete next[phone];
      }
      if (currentUser) {
        localStorage.setItem(`nicknames_${currentUser}`, JSON.stringify(next));
      }
      return next;
    });
    setActiveChat(prev => {
      if (prev?.type === "user" && prev.id === phone) {
        const c = contacts.find(c => c.phone_number === phone);
        const newLabel = trimmed || c?.display_name || phone;
        return { ...prev, name: newLabel };
      }
      return prev;
    });
    setShowHeaderNicknameEdit(false);
  };

  const openHeaderNicknameEdit = () => {
    if (!activeChat || activeChat.type !== "user") return;
    const phone = String(activeChat.id);
    setHeaderNicknameValue(nicknames[phone] || "");
    setShowHeaderNicknameEdit(true);
  };

  const openChat = async (chat: Chat) => {
    setActiveChat(chat);
    setShowHeaderNicknameEdit(false);
    setShowContactProfile(false);
    if (messagesCache.current[chat.id]) {
      setMessages(messagesCache.current[chat.id]);
      setTimeout(scrollBottom, 10);
    } else {
      setMessages([]);
    }
    setHasMore(false);
    setShowEmojis(false);
    setEditingId(null);
    setUnread(prev => ({ ...prev, [chat.id]: 0 }));
    await loadHistory(chat);
  };

  const sendMessage = async () => {
    const text = inputMsg.trim();
    if (!text || !activeChat || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setInputMsg(""); setShowEmojis(false);

    const { type, id } = activeChat;

    const optimisticMsg: Message = {
      id: `temp-${Date.now()}-${Math.random()}`,
      user: currentUser,
      content: text,
      timestamp: new Date().toISOString(),
      ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name })
    };

    setMessages(prev => {
      const next = [...prev, optimisticMsg];
      messagesCache.current[id] = next;
      return next;
    });
    setTimeout(scrollBottom, 50);

    wsRef.current.send(JSON.stringify(type === "user"
      ? { type: "direct_message", target_user: id, content: text, message_type: "text" }
      : { type: "group_message", group_id: id, content: text, message_type: "text" }));
  };

  const saveEdit = async () => {
    if (!editingId || !activeChat) return;
    try {
      await apiFetch<void>(`/messages/${editingId}`, { method: "PATCH", body: JSON.stringify({ content: editingText }) });
      setMessages(prev => prev.map(m => m.id === editingId ? { ...m, content: editingText, edited_at: new Date().toISOString() } : m));
      setEditingId(null); setEditingText("");
    } catch { }
  };

  const deleteMsg = async (id: string | number) => {
    try {
      await apiFetch<void>(`/messages/${id}`, { method: "DELETE" });
      setMessages(prev => prev.map(m => m.id === id ? { ...m, is_deleted: true } : m));
    } catch { }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputMsg(e.target.value);
    if (wsRef.current?.readyState === WebSocket.OPEN && activeChat?.type === "user") {
      wsRef.current.send(JSON.stringify({ type: "typing", target_user: activeChat.id }));
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeChat) return;
    const form = new FormData(); form.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      if (!res.ok) { alert("Upload failed"); return; }
      const data = await res.json();

      const isImg = data.content_type?.startsWith("image");
      const isAud = data.content_type?.startsWith("audio");
      const isVid = data.content_type?.startsWith("video");
      const isPdf = data.content_type === "application/pdf";

      const tag = isImg ? `[IMAGE]${data.url}`
        : isAud ? `[AUDIO]${data.url}`
          : isVid ? `[VIDEO]${data.url}`
            : isPdf ? `[PDF]${data.url}`
              : `[FILE]${data.url}`;

      const msgType = isImg ? "image" : isAud ? "audio" : isVid ? "video" : isPdf ? "pdf" : "file";
      const { type, id } = activeChat;

      const optimisticMsg: Message = {
        id: `temp-${Date.now()}-${Math.random()}`,
        user: currentUser,
        content: tag,
        timestamp: new Date().toISOString(),
        ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name })
      };

      setMessages(prev => {
        const next = [...prev, optimisticMsg];
        messagesCache.current[id] = next;
        return next;
      });
      setTimeout(scrollBottom, 50);

      wsRef.current?.send(JSON.stringify(type === "user"
        ? { type: "direct_message", target_user: id, content: tag, message_type: msgType }
        : { type: "group_message", group_id: id, content: tag, message_type: msgType }));
    } catch { }
    e.target.value = "";
  };

  const toggleRecording = async () => {
    if (!activeChat) return;
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop());
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = e => audioChunksRef.current.push(e.data);
      mr.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const form = new FormData();
        form.append("file", blob, "voice.webm");

        const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
        const data = await res.json();
        const tag = `[AUDIO]${data.url}`;
        const { type, id } = activeChat;

        const optimisticMsg: Message = {
          id: `temp-${Date.now()}-${Math.random()}`,
          user: currentUser,
          content: tag,
          timestamp: new Date().toISOString(),
          ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name })
        };
        setMessages(prev => {
          const next = [...prev, optimisticMsg];
          messagesCache.current[id] = next;
          return next;
        });
        setTimeout(scrollBottom, 50);

        wsRef.current?.send(JSON.stringify(type === "user"
          ? { type: "direct_message", target_user: id, content: tag, message_type: "audio" }
          : { type: "group_message", group_id: id, content: tag, message_type: "audio" }));
      };
      mr.start(); setIsRecording(true);
    } catch { }
  };

  const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  const setupWebRTC = async (targetUser: string) => {
    const localStream = localStreamRef.current;
    if (!localStream) throw new Error("Local media stream is not available");

    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = peerConnection;
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
      remoteStreamRef.current = event.streams[0];
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        // Explicitly call play to ensure media renders immediately when the track updates
        remoteVideoRef.current.play().catch(() => {});
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ice_candidate", target_user: targetUser, candidate: event.candidate }));
      }
    };
  };

  const startCall = async (video = true) => {
    if (!activeChat || activeChat.type !== "user") return;
    const target = String(activeChat.id);

    try {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }

      iceCandidateQueueRef.current = []; // Clear queue on new call
      setIsVideoCall(video);
      updateCallState("calling");
      setCallPeer(target);
      callDirectionRef.current = "outgoing";

      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;

      await setupWebRTC(target);
      const peerConnection = peerConnectionRef.current;
      const ws = wsRef.current;
      if (!peerConnection || ws?.readyState !== WebSocket.OPEN) throw new Error("Call connection is not ready");
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      ws.send(JSON.stringify({ type: "call_offer", target_user: target, sdp: offer, isVideo: video }));
    } catch (err: any) {
      console.error("Media access failed:", err);
      alert(`Could not access camera/microphone. Reason: ${err.name || err.message}`);
      endCall(false);
    }
  };

  const acceptCall = async () => {
    try {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }

      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: isVideoCall, audio: true });
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;

      if (!callPeer || !pendingRemoteDescriptionRef.current) throw new Error("Call offer is not available");
      await setupWebRTC(callPeer);

      const peerConnection = peerConnectionRef.current;
      const ws = wsRef.current;
      if (!peerConnection || ws?.readyState !== WebSocket.OPEN) throw new Error("Call connection is not ready");
      const offer = new RTCSessionDescription(pendingRemoteDescriptionRef.current);
      await peerConnection.setRemoteDescription(offer);

      // Process any ICE candidates that were queued while setting up the media
      while (iceCandidateQueueRef.current.length > 0) {
        const candidate = iceCandidateQueueRef.current.shift();
        if (candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
        }
      }

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      ws.send(JSON.stringify({ type: "call_answer", target_user: callPeer, sdp: answer }));

      updateCallState("connected");
      callStartTimeRef.current = Date.now();
    } catch (err: any) {
      console.error("Accept call media failed:", err);
      rejectCall();
    }
  };

  const rejectCall = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call_reject", target_user: callPeer }));
    }
    endCall(false, "rejected");
  };

  const formatTime = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const formatDate = (ts: string) => {
    const d = new Date(ts); const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const groupedMessages = useMemo(() => {
    const out: GroupedMessage[] = []; let lastDate: string | null = null;
    for (const msg of messages) {
      const label = formatDate(msg.timestamp);
      if (label !== lastDate) { out.push({ type: "divider", label }); lastDate = label; }
      out.push({ type: "msg", ...msg });
    }
    return out;
  }, [messages]);

  const contactLabel = (c: Contact) => nicknames[c.phone_number] || c.display_name || c.phone_number;

  if (!isMounted) return (
    <div className="app loading-screen">
      <div className="spinner loading-spinner-circle"></div>
    </div>
  );

  return (
    <div className="app">
      {!isAuth ? (
        <div className="auth-screen">
          <div className="auth-glow auth-glow-1"></div>
          <div className="auth-glow auth-glow-2"></div>
          <div className="auth-left">
            <div className="brand">
              <div className="brand-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </div>
              <span className="brand-name">Pulse</span>
            </div>
            <div className="auth-hero">
              <h1>Connect.<br />Fast.<br /><em>Alive.</em></h1>
              <p>Keep your conversations flowing with real-time speed.</p>
            </div>
            <div className="auth-pills">
              <span className="a-pill a-pill--primary">⚡ Fast</span>
              <span className="a-pill">💬 Real-time</span>
              <span className="a-pill">📱 Mobile-ready</span>
            </div>
          </div>

          <div className="auth-right">
            <div className="auth-card">
              {!otpSent ? (
                <>
                  <h2 className="ac-title">Sign in</h2>
                  <p className="ac-sub">Enter your phone number to get a one-time code</p>
                  <div className="ac-field">
                    <label>Phone number</label>
                    <div className="ac-input-wrap">
                      <svg className="ac-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                      <input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} onKeyDown={e => e.key === "Enter" && sendOTP()} type="tel" placeholder="+91 98765 43210" className="ac-input" />
                    </div>
                  </div>
                  <button disabled={authLoading} onClick={sendOTP} className="ac-btn">
                    {authLoading && <span className="spinner"></span>}
                    {authLoading ? "Sending…" : "Get verification code"}
                    {!authLoading && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setOtpSent(false)} className="ac-back">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg> Back
                  </button>
                  <h2 className="ac-title">Verify code</h2>
                  <p className="ac-sub">6-digit code sent to <strong>{phoneNumber}</strong></p>
                  <div className="ac-field">
                    <label>Verification code</label>
                    <input value={otp} onChange={e => setOtp(e.target.value)} onKeyDown={e => e.key === "Enter" && verifyOTP()} type="text" placeholder="000000" maxLength={6} className="ac-input ac-otp" />
                  </div>
                  <button disabled={authLoading} onClick={verifyOTP} className="ac-btn">
                    {authLoading && <span className="spinner"></span>}
                    {authLoading ? "Verifying…" : "Verify & sign in"}
                    {!authLoading && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                  </button>
                </>
              )}
              {authError && (
                <div className="ac-error">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                  {authError}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className={`shell ${activeChat ? "chat-active" : ""}`}>
          <aside className="sidebar">
            <div className="sb-identity">
              <div className="sb-id-avatar">
                {profile.avatarUrl ? (
                  <img src={profile.avatarUrl} alt="Avatar" className="img-cover rounded-sq" />
                ) : (
                  (profile.displayName || currentUser)?.[0]?.toUpperCase() || "?"
                )}
              </div>
              <div className="sb-id-info">
                <span className="sb-id-name">{profile.displayName || currentUser}</span>
                <span className="sb-id-status"><span className="green-dot"></span>Online</span>
              </div>
            </div>

            <button onClick={logout} className="logout-bar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg> Sign Out
            </button>

            <div className="sb-profile-toggle" onClick={() => setShowProfile(!showProfile)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg> Edit My Profile
              <svg className={`chevron ${showProfile ? "chevron--up" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6,9 12,15 18,9" /></svg>
            </div>

            {showProfile && (
              <div className="sb-profile-form drop">
                <input type="file" ref={avatarInputRef} accept="image/*" className="hidden-input" onChange={handleAvatarUpload} />
                <div className="avatar-edit-section">
                  <div className="avatar-edit-row">
                    <div className="avatar-edit-box">
                      {profile.avatarUrl
                        ? <img src={profile.avatarUrl} alt="Avatar" className="img-cover" />
                        : (profile.displayName || currentUser)?.[0]?.toUpperCase() || "?"}
                    </div>
                    <button
                      onClick={() => avatarInputRef.current?.click()}
                      className="avatar-upload-btn"
                      disabled={isUploadingAvatar}
                    >
                      {isUploadingAvatar ? "Uploading…" : "📷 Change Picture"}
                    </button>
                  </div>
                  <p className="text-muted-sm">
                    Your profile picture is visible to all your contacts.
                  </p>
                </div>
                <input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} placeholder="Display name…" className="sb-field" />
                <p className="text-muted-sm text-muted-sm-margin">
                  Your display name is shown to everyone who has your number.
                </p>
                <button onClick={saveProfile} className="sb-save-btn">Save Profile</button>
              </div>
            )}

            <div className="sb-profile-toggle" onClick={() => setShowCallLogUI(true)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg> Call History
            </div>

            <div className="sb-divider"></div>

            <div className="sb-section">
              <div className="sb-section-hdr">
                <div className="sb-section-label">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg> Direct Messages
                </div>
                <button onClick={() => setShowNewContact(!showNewContact)} className={`sb-add-btn ${showNewContact ? "active" : ""}`} title="New chat">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                </button>
              </div>
              {showNewContact && (
                <div className="sb-add-form drop">
                  <input
                    value={newContactPhone}
                    onChange={e => setNewContactPhone(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        apiFetch("/contacts", { method: "POST", body: JSON.stringify({ contact_phone: newContactPhone.trim() }) })
                          .then(() => { loadContacts(); openChat({ type: "user", id: newContactPhone.trim(), name: newContactPhone.trim() }); setNewContactPhone(""); setShowNewContact(false); });
                      }
                    }}
                    placeholder="+91 phone number…"
                    className="sb-field"
                    autoFocus
                  />
                  <button
                    onClick={() => {
                      apiFetch("/contacts", { method: "POST", body: JSON.stringify({ contact_phone: newContactPhone.trim() }) })
                        .then(() => { loadContacts(); openChat({ type: "user", id: newContactPhone.trim(), name: newContactPhone.trim() }); setNewContactPhone(""); setShowNewContact(false); });
                    }}
                    className="sb-go-btn"
                  >
                    Start chat
                  </button>
                </div>
              )}

              <div className="sb-list">
                {contacts.map(c => {
                  const label = contactLabel(c);
                  return (
                    <button
                      key={c.phone_number}
                      onClick={() => openChat({ type: "user", id: c.phone_number, name: label })}
                      className={`sb-item ${activeChat?.id === c.phone_number ? "sb-item--active" : ""}`}
                    >
                      <div className="sb-av">
                        {c.avatar_url ? (
                          <img src={c.avatar_url} alt="avatar" className="img-cover rounded-circle" />
                        ) : (
                          label?.[0]?.toUpperCase() || "?"
                        )}
                        <span className={`pres ${c.is_online ? "pres--on" : ""}`}></span>
                      </div>
                      <div className="sb-item-body mw-0">
                        <span className="sb-item-name name-row">
                          {nicknames[c.phone_number] ? (
                            <>
                              <span>{nicknames[c.phone_number]}</span>
                              <span className="name-meta">
                                ({c.display_name || c.phone_number})
                              </span>
                            </>
                          ) : (
                            <span>{label}</span>
                          )}
                        </span>
                        <span className={`sb-item-status ${c.is_online ? "online" : ""}`}>
                          {c.is_online ? "● Online" : "○ Offline"}
                        </span>
                      </div>
                      {unread[c.phone_number] > 0 && <span className="unread">{unread[c.phone_number]}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sb-divider"></div>

            <div className="sb-section">
              <div className="sb-section-hdr">
                <div className="sb-section-label">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg> Groups
                </div>
                <button onClick={() => setShowNewGroup(!showNewGroup)} className={`sb-add-btn ${showNewGroup ? "active" : ""}`} title="New group">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                </button>
              </div>
              {showNewGroup && (
                <div className="sb-add-form drop">
                  <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Group name *" className="sb-field" />
                  <input value={newGroupMembers} onChange={e => setNewGroupMembers(e.target.value)} placeholder="Members (comma-separated) *" className="sb-field" />
                  <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} placeholder="Description (optional)" className="sb-field" />
                  <button
                    onClick={() => {
                      const members = newGroupMembers.trim().split(",").map(s => s.trim()).filter(Boolean);
                      if (!newGroupName.trim() || !members.length) return;
                      apiFetch("/groups", { method: "POST", body: JSON.stringify({ name: newGroupName.trim(), description: newGroupDesc, members }) })
                        .then(() => { setNewGroupName(""); setNewGroupDesc(""); setNewGroupMembers(""); setShowNewGroup(false); loadGroups(); });
                    }}
                    className="sb-go-btn secondary"
                  >
                    Create group
                  </button>
                </div>
              )}
              <div className="sb-list">
                {groups.map(g => (
                  <button key={g.id} onClick={() => openChat({ type: "group", id: g.id, name: g.name })} className={`sb-item ${activeChat?.id === g.id ? "sb-item--active-group" : ""}`}>
                    <div className="sb-av sb-av--group">{g.name?.[0]?.toUpperCase() || "?"}</div>
                    <div className="sb-item-body">
                      <span className="sb-item-name">{g.name}</span>
                      <span className="sb-item-status">{g.members.length} members</span>
                    </div>
                    {unread[g.id] > 0 && <span className="unread unread--secondary">{unread[g.id]}</span>}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <main className="chat">
            {!activeChat ? (
              <div className="empty-state">
                <div className="empty-rings">
                  <div className="ring r1"></div><div className="ring r2"></div><div className="ring r3"></div>
                  <svg className="z-1-relative" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                </div>
                <h3>No conversation open</h3>
                <p>Select a contact or group from the sidebar to start messaging</p>
              </div>
            ) : (
              <>
                <header className="chat-hdr">
                  <div className="chat-hdr-left">
                    <button className="mobile-back-btn" onClick={() => setActiveChat(null)}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                    </button>

                    <div
                      className={`hdr-av ${activeChat.type === "group" ? "hdr-av--group" : "hdr-av--dm"} ${activeChat.type === "user" ? "cursor-pointer pointer-relative" : "default-relative"}`}
                      onClick={() => activeChat.type === "user" && setShowContactProfile(true)}
                      title={activeChat.type === "user" ? "View profile" : undefined}
                    >
                      {activeChat.type === "user" && contacts.find(c => c.phone_number === activeChat.id)?.avatar_url ? (
                        <img src={contacts.find(c => c.phone_number === activeChat.id)!.avatar_url!} alt="avatar" className="img-cover rounded-circle" />
                      ) : (
                        activeChat.name?.[0]?.toUpperCase() || "?"
                      )}
                      {activeChat.type === "user" && (
                        <div className="hdr-av-overlay">
                          view
                        </div>
                      )}
                    </div>

                    <div className="hdr-info">
                      <div className="name-row-inline">
                        <span className="hdr-name">
                          {activeChat.type === "user" ? (
                            (() => {
                              const c = contacts.find(c => c.phone_number === activeChat.id);
                              return c ? contactLabel(c) : activeChat.name;
                            })()
                          ) : activeChat.name}
                        </span>

                        {activeChat.type === "user" && (
                          <button
                            onClick={openHeaderNicknameEdit}
                            title="Set a private nickname for this contact"
                            className={`btn-pencil-nickname ${showHeaderNicknameEdit ? "active" : ""}`}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {activeChat.type === "user" && (() => {
                        const c = contacts.find(c => c.phone_number === activeChat.id);
                        return nicknames[activeChat.id as string] ? (
                          <span className="hdr-meta hdr-meta-nickname">
                            {c?.display_name || c?.phone_number || activeChat.id}
                          </span>
                        ) : null;
                      })()}

                      <span className="hdr-meta">
                        {activeChat.type === "user" ? (
                          <>
                            <span className={`hdr-dot ${contacts.find(c => c.phone_number === activeChat.id)?.is_online ? "hdr-dot--on" : ""}`}></span>
                            {contacts.find(c => c.phone_number === activeChat.id)?.is_online ? "Online" : "Offline"}
                          </>
                        ) : (
                          <>{groups.find(g => g.id === activeChat.id)?.members.length || "?"} members</>
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="hdr-right">
                    {activeChat.type === "user" && (
                      <>
                        <button onClick={() => startCall(false)} className="tool-btn call-hdr-btn" title="Voice Call">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                        </button>
                        <button onClick={() => startCall(true)} className="tool-btn call-hdr-btn" title="Video Call">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
                        </button>
                      </>
                    )}
                  </div>
                </header>

                {showHeaderNicknameEdit && activeChat.type === "user" && (
                  <div className="nickname-edit-panel">
                    <span className="nickname-edit-label">
                      🏷 Private nickname:
                    </span>
                    <input
                      value={headerNicknameValue}
                      onChange={e => setHeaderNicknameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveContactNickname(String(activeChat.id), headerNicknameValue);
                        if (e.key === "Escape") setShowHeaderNicknameEdit(false);
                      }}
                      placeholder={(() => {
                        const c = contacts.find(c => c.phone_number === activeChat.id);
                        return `Nickname for ${c?.display_name || c?.phone_number || activeChat.id}`;
                      })()}
                      className="sb-field nickname-edit-input"
                      autoFocus
                    />
                    <div className="nickname-edit-actions">
                      <button
                        onClick={() => saveContactNickname(String(activeChat.id), headerNicknameValue)}
                        className="sb-go-btn btn-save-sm"
                      >
                        Save
                      </button>
                      {nicknames[String(activeChat.id)] && (
                        <button
                          onClick={() => saveContactNickname(String(activeChat.id), "")}
                          className="sb-go-btn btn-clear-sm"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        onClick={() => setShowHeaderNicknameEdit(false)}
                        className="sb-go-btn btn-close-sm"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}

                {hasMore && (
                  <div className="load-more-row">
                    <button onClick={() => messages.length && loadHistory(activeChat, messages[0].id)} disabled={loadingMore} className="load-more-btn">
                      {loadingMore ? "Loading…" : "↑ Load older messages"}
                    </button>
                  </div>
                )}

                <div ref={msgListRef} className="msg-list">
                  {groupedMessages.map((item, idx) => (
                    item.type === "divider" ? (
                      <div key={`div-${item.label}-${idx}`} className="date-sep"><span>{item.label}</span></div>
                    ) : (
                      <div key={item.id} className={`msg-row ${item.user === currentUser ? "msg-mine" : "msg-theirs"}`}>
                        {item.is_deleted ? (
                          <div className="msg-deleted">Message deleted</div>
                        ) : editingId === item.id ? (
                          <div className="edit-row">
                            <input value={editingText} onChange={e => setEditingText(e.target.value)} onKeyDown={e => e.key === "Enter" && saveEdit()} onKeyUp={e => e.key === "Escape" && setEditingId(null)} className="edit-field" autoFocus />
                            <button onClick={saveEdit} className="edit-save">✓</button>
                            <button onClick={() => setEditingId(null)} className="edit-discard">✕</button>
                          </div>
                        ) : (
                          <div className="bw">
                            {activeChat.type === "group" && item.user !== currentUser && <span className="sender-name">{item.user}</span>}
                            <div className={`bubble ${item.user === currentUser ? "mine" : "theirs"}`}>
                              {item.content.startsWith("[IMAGE]") ? (
                                <img src={item.content.replace("[IMAGE]", "")} alt="attachment" className="msg-img msg-img-media" onClick={() => setViewFile({ url: item.content.replace("[IMAGE]", ""), type: "image" })} />
                              ) : item.content.startsWith("[AUDIO]") ? (
                                <audio src={item.content.replace("[AUDIO]", "")} controls className="msg-audio msg-audio-media"></audio>
                              ) : item.content.startsWith("[VIDEO]") ? (
                                <video src={item.content.replace("[VIDEO]", "")} controls className="msg-video msg-video-media" onClick={() => setViewFile({ url: item.content.replace("[VIDEO]", ""), type: "video" })}></video>
                              ) : item.content.startsWith("[PDF]") ? (
                                <iframe src={item.content.replace("[PDF]", "")} className="msg-pdf msg-pdf-media" title="PDF attachment"></iframe>
                              ) : item.content.startsWith("[FILE]") ? (
                                <a href={item.content.replace("[FILE]", "")} target="_blank" rel="noreferrer" className="msg-file-link">
                                  Download file
                                </a>
                              ) : (
                                <span className="msg-text">{item.content}</span>
                              )}

                              <div className="msg-footer">
                                <span className="msg-ts">{formatTime(item.timestamp)}</span>
                                {item.edited_at && <span className="msg-edited">edited</span>}
                                {item.user === currentUser && activeChat.type === "user" && (
                                  <span className={`ticks ${item.is_read ? "ticks--read" : ""}`}>
                                    {item.is_read ? (
                                      <svg width="14" height="9" viewBox="0 0 22 14" fill="none"><path d="M1 7L6 12L15 1" stroke="currentColor" strokeWidth="2" /><path d="M8 7L13 12L22 1" stroke="currentColor" strokeWidth="2" /></svg>
                                    ) : (
                                      <svg width="10" height="9" viewBox="0 0 14 14" fill="none"><path d="M1 7L6 12L13 1" stroke="currentColor" strokeWidth="2" /></svg>
                                    )}
                                  </span>
                                )}
                              </div>

                              {item.user === currentUser && (
                                <div className="bubble-actions">
                                  <button onClick={(e) => { e.stopPropagation(); setEditingId(item.id); setEditingText(item.content); }} title="Edit">✎</button>
                                  <button onClick={(e) => { e.stopPropagation(); deleteMsg(item.id); }} className="del-action" title="Delete">🗑</button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  ))}
                </div>

                <div className="typing-area">
                  {isTyping && <div className="typing-pill fade"><span className="td"></span><span className="td"></span><span className="td"></span><span>{activeChat.name} is typing…</span></div>}
                </div>

                {showEmojis && (
                  <div className="emoji-picker pop">
                    {emojis.map(e => <button key={e} onClick={() => setInputMsg(prev => prev + e)} className="emoji-btn">{e}</button>)}
                  </div>
                )}

                <div className="input-bar">
                  <input type="file" ref={fileInputRef} onChange={handleFile} accept="image/*,audio/*,video/mp4,.pdf" className="hidden-input" />
                  <button onClick={() => setShowEmojis(!showEmojis)} className={`tool-btn ${showEmojis ? "tool-btn--on" : ""}`}>😀</button>
                  <button onClick={() => fileInputRef.current?.click()} className="tool-btn">📎</button>
                  <button onClick={toggleRecording} className={`tool-btn ${isRecording ? "tool-btn--rec" : ""}`}>🎤{isRecording && <span className="rec-dot"></span>}</button>
                  <input value={inputMsg} onChange={handleTyping} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Type a message…" className="msg-input" disabled={isRecording} />
                  <button onClick={sendMessage} disabled={isRecording || !inputMsg.trim()} className="send-btn">➤</button>
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {showContactProfile && activeChat?.type === "user" && (() => {
        const c = contacts.find(c => c.phone_number === activeChat.id);
        const label = c ? contactLabel(c) : activeChat.name;
        const avatarUrl = c?.avatar_url;
        const initials = label?.[0]?.toUpperCase() || "?";
        return (
          <div
            className="file-viewer-overlay cp-backdrop"
            onClick={() => setShowContactProfile(false)}
          >
            <div className="cp-modal" onClick={e => e.stopPropagation()}>
              <button className="cp-close-btn" onClick={() => setShowContactProfile(false)}>✕</button>

              <div className="cp-hero">
                <div className="cp-avatar">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Profile" className="img-cover" />
                  ) : initials}
                </div>

                <div className="cp-name-wrap">
                  <div className="cp-name">{label}</div>
                  {nicknames[c?.phone_number || ""] && (
                    <div className="cp-sub">{c?.display_name || c?.phone_number}</div>
                  )}
                </div>

                <div className={`cp-badge ${c?.is_online ? "cp-badge-online" : "cp-badge-offline"}`}>
                  <span className={`cp-badge-dot ${c?.is_online ? "online" : "offline"}`}></span>
                  {c?.is_online ? "Online" : "Offline"}
                </div>
              </div>

              <div className="cp-body">
                <div className="cp-row">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" />
                  </svg>
                  <div>
                    <div className="cp-row-label">Phone</div>
                    <div className="cp-row-val">{c?.phone_number || activeChat.id}</div>
                  </div>
                </div>

                <div className="cp-row cp-row-between">
                  <div className="cp-row-align">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
                    </svg>
                    <div>
                      <div className="cp-row-label">Your nickname</div>
                      <div className={`cp-row-val ${!nicknames[c?.phone_number || ""] ? "muted" : ""}`}>
                        {nicknames[c?.phone_number || ""] || "Not set"}
                      </div>
                    </div>
                  </div>
                  <button
                    className="cp-edit-btn"
                    onClick={() => {
                      setShowContactProfile(false);
                      openHeaderNicknameEdit();
                    }}
                  >
                    {nicknames[c?.phone_number || ""] ? "Edit" : "Add"}
                  </button>
                </div>

                <div className="cp-actions">
                  <button className="cp-action-btn" onClick={() => { setShowContactProfile(false); startCall(false); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" />
                    </svg>
                    Voice call
                  </button>
                  <button className="cp-action-btn primary" onClick={() => { setShowContactProfile(false); startCall(true); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                    </svg>
                    Video call
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {showCallLogUI && (
        <div className="file-viewer-overlay" onClick={() => setShowCallLogUI(false)}>
          <div className="viewer-content cl-modal" onClick={e => e.stopPropagation()}>
            <div className="cl-header">
              <h2 className="cl-title">Call History</h2>
              <button className="cl-close" onClick={() => setShowCallLogUI(false)}>✕</button>
            </div>

            {callLogs.length === 0 ? (
              <p className="cl-empty">No recent calls</p>
            ) : (
              <div className="cl-list">
                {callLogs.map(log => (
                  <div key={log.id} className="cl-item">
                    <div>
                      <strong className={`cl-item-name ${log.status === "missed" || log.status === "rejected" ? "missed" : ""}`}>
                        {(() => {
                          const c = contacts.find(c => c.phone_number === log.peer);
                          return c ? contactLabel(c) : log.peer;
                        })()}
                      </strong>
                      <span className="cl-item-meta">
                        <span>{log.direction === "incoming" ? "↙ Incoming" : "↗ Outgoing"}</span>
                        <span>•</span>
                        <span>{log.media === "video" ? "📹 Video" : "📞 Audio"}</span>
                        <span>•</span>
                        <span>{new Date(log.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                    </div>
                    <div className="cl-item-dur">
                      {log.status === "completed" ? `${Math.floor(log.duration / 60)}m ${log.duration % 60}s` : <span className="cl-item-dur status">{log.status}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {callState !== "idle" && (
        <div className="call-overlay">
          <div className={`call-modal ${isVideoCall && callState === "connected" ? "video-active" : ""}`}>
            <div className={`video-container ${(isVideoCall && (callState === "connected" || callState === "calling")) ? "d-block" : "d-none"}`}>
              <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline></video>
              <video ref={localVideoRef} className="local-video" autoPlay playsInline muted></video>
            </div>

            {(!isVideoCall || callState !== "connected") && (
              <div className="call-info">
                <div className={`call-avatar ${callState === "calling" || callState === "incoming" ? "pulse-anim" : ""}`}>
                  {callPeer?.[0]?.toUpperCase()}
                </div>
                <h2 className="call-name">
                  {callPeer && (() => {
                    const c = contacts.find(c => c.phone_number === callPeer);
                    return c ? contactLabel(c) : callPeer;
                  })()}
                </h2>
                <p className="call-status">
                  {callState === "incoming" ? `Incoming ${isVideoCall ? "Video" : "Voice"} Call...` : callState === "calling" ? "Calling..." : "Connected"}
                </p>
              </div>
            )}

            <div className="call-controls">
              {callState === "incoming" ? (
                <>
                  <button onClick={rejectCall} className="call-btn btn-reject" title="Reject">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                  </button>
                  <button onClick={acceptCall} className="call-btn btn-accept" title="Accept">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                  </button>
                </>
              ) : (
                <button onClick={() => endCall(true)} className="call-btn btn-end" title="End Call">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {viewFile && (
        <div className="file-viewer-overlay" onClick={() => setViewFile(null)}>
          <button className="close-viewer" onClick={() => setViewFile(null)}>✕</button>
          <div className="viewer-content" onClick={e => e.stopPropagation()}>
            {viewFile.type === "image" && <img src={viewFile.url} alt="attachment" />}
            {viewFile.type === "video" && <video src={viewFile.url} controls autoPlay />}
          </div>
        </div>
      )}
    </div>
  );
}
