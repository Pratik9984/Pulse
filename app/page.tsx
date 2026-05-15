"use client";

// ─── PULSE v5.5 — No Google Auth · Forgot/Reset Password ──────────────────────
//  Removed: "Continue with Google" OAuth button
//  Added:   forgot-password step (sends Supabase reset email)
//  Added:   reset-password step  (updateUser with new password)
//  Added:   onAuthStateChange → PASSWORD_RECOVERY detection
// ──────────────────────────────────────────────────────────────────────────────

import React, {
  useState, useEffect, useRef, useMemo, useCallback,
  useReducer, useLayoutEffect, memo,
} from "react";
import { createPortal } from "react-dom";
import "./globals.css";

import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

// ─── TYPES ────────────────────────────────────────────────────────────────────
type Chat = { type: "user" | "group"; id: string | number; name: string };
type Contact = { email: string; username?: string | null; display_name?: string | null; nickname?: string | null; is_online?: boolean; avatar_url?: string | null };
type Group = { id: string | number; name: string; members: any[]; avatar_url?: string | null };
type Message = {
  id: string | number; user: string; content: string; timestamp: string;
  group_id?: string | number; group_name?: string; receiver_email?: string;
  target_user?: string; is_read?: boolean; is_deleted?: boolean;
  edited_at?: string; reply_to_id?: string | number; reply_to_content?: string;
  reactions?: Record<string, string[]>; read_by?: string[];
  sender_name?: string; sender_avatar?: string; _callRecord?: boolean;
};
type GroupedMessage = { type: "divider"; label: string } | ({ type: "msg" } & Message);
type CallState = "idle" | "incoming" | "calling" | "connected";
type ApiOptions = RequestInit & { headers?: HeadersInit; signal?: AbortSignal };
type AuthStep = "signin" | "signup" | "pick-username" | "verify-email" | "forgot-password" | "reset-password";
type CallLogEntry = { id: string; peer: string; peerName: string; direction: "incoming" | "outgoing"; media: "audio" | "video"; status: "completed" | "missed" | "rejected"; timestamp: string; duration: number };
type WsStatus = "connected" | "disconnected" | "reconnecting";
type ProfileTab = "info" | "media" | "calls" | "members";

// ─── AUTH REDUCER ─────────────────────────────────────────────────────────────
type AuthState = { step: AuthStep; email: string; pass: string; pass2: string; user: string; loading: boolean; error: string };
type AuthAction = | { type: "SET_STEP"; step: AuthStep } | { type: "SET_FIELD"; field: "email" | "pass" | "pass2" | "user"; value: string } | { type: "SET_LOADING"; value: boolean } | { type: "SET_ERROR"; value: string } | { type: "RESET" };
const authInit: AuthState = { step: "signin", email: "", pass: "", pass2: "", user: "", loading: false, error: "" };
function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "SET_STEP": return { ...state, step: action.step, error: "" };
    case "SET_FIELD": return { ...state, [action.field]: action.value };
    case "SET_LOADING": return { ...state, loading: action.value };
    case "SET_ERROR": return { ...state, error: action.value, loading: false };
    case "RESET": return authInit;
    default: return state;
  }
}

// ─── HOOKS ────────────────────────────────────────────────────────────────────
function useDebounce<T>(value: T, delay: number): T {
  const [deb, setDeb] = useState(value);
  useEffect(() => { const id = setTimeout(() => setDeb(value), delay); return () => clearTimeout(id); }, [value, delay]);
  return deb;
}
function useDebounceCallback<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  return useCallback((...args: any[]) => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => fnRef.current(...args), delay); }, [delay]) as T;
}
function useDebouncedLocalStorage(key: string, value: unknown, delay = 800) {
  const debouncedValue = useDebounce(value, delay);
  useEffect(() => { if (key) { try { localStorage.setItem(key, JSON.stringify(debouncedValue)); } catch { } } }, [key, debouncedValue]);
}

// ─── IDB HELPERS ─────────────────────────────────────────────────────────────
function idbSet(key: string, value: string): void {
  if (typeof indexedDB === "undefined") return;
  try { const req = indexedDB.open("pulse-sw", 1); req.onupgradeneeded = () => req.result.createObjectStore("kv"); req.onsuccess = () => { const tx = req.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(value, key); }; } catch { }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Request failed");
const API = process.env.NEXT_PUBLIC_API_URL || "https://pratik0165-pulsebackend.hf.space";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || API.replace(/^http/, "ws");
const getEmail = (m: any) => (m && typeof m === "object" ? m.email : m) as string;
const getIsAdmin = (m: any) => !!(m && typeof m === "object" && m.is_admin);
const safeParseJSON = <T,>(str: string | null, fallback: T): T => { if (!str) return fallback; try { return JSON.parse(str); } catch { return fallback; } };
const USERNAME_RE = /^[a-z0-9_]{3,30}$/;
const fmtDuration = (sec: number) => { const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${s.toString().padStart(2, "0")}`; };
const parseTs = (ts: string): Date => { if (!ts) return new Date(); const hasOffset = ts.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(ts); return new Date(hasOffset ? ts : ts + "Z"); };
const formatTimeAgo = (ts: number): string => {
  if (!ts) return "";
  const diff = Date.now() - ts, mins = Math.floor(diff / 60000);
  if (mins < 1) return "now"; if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

// ─── REACTION PICKER PORTAL ───────────────────────────────────────────────────
interface ReactionPickerPortalProps {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  isMine: boolean;
  emojis: string[];
  onReact: (emoji: string) => void;
  onClose: () => void;
}
function ReactionPickerPortal({ anchorRef, isMine, emojis, onReact, onClose }: ReactionPickerPortalProps) {
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", zIndex: 9999, opacity: 0, pointerEvents: "none" });
  const pickerRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useLayoutEffect(() => {
    if (!anchorRef.current || !pickerRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const picker = pickerRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pickerW = picker.width || emojis.length * 44 + 16;
    const pickerH = picker.height || 56;
    let left = isMine ? anchor.right - pickerW : anchor.left;
    left = Math.max(8, Math.min(left, vw - pickerW - 8));
    let top = anchor.top - pickerH - 8;
    if (top < 8) top = anchor.bottom + 8;
    top = Math.max(8, Math.min(top, vh - pickerH - 8));
    setStyle({ position: "fixed", zIndex: 9999, top, left, opacity: 1, pointerEvents: "auto" });
  }, [mounted, isMine, emojis.length]); // eslint-disable-line

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onMouseDown={e => { e.stopPropagation(); onClose(); }}
        onTouchStart={e => { e.stopPropagation(); onClose(); }}
      />
      <div
        ref={pickerRef}
        className="reaction-picker pop"
        style={style}
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchMove={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
      >
        {emojis.map(e => (
          <button
            key={e}
            className="reaction-btn"
            onMouseDown={ev => { ev.stopPropagation(); onReact(e); }}
            onTouchEnd={ev => { ev.stopPropagation(); onReact(e); }}
          >
            {e}
          </button>
        ))}
      </div>
    </>,
    document.body
  );
}

// ─── CONTACT ITEM ─────────────────────────────────────────────────────────────
interface ContactItemProps {
  contact: Contact; isActive: boolean; isDeleteTarget: boolean;
  unreadCount: number; lastPreview: string; label: string; nickname?: string; lastActivityTs: number;
  onOpen: () => void; onDelete: () => void; onDeleteTarget: (id: string) => void; onClearDelete: () => void;
}
const ContactItem = memo(function ContactItem({ contact: c, isActive, isDeleteTarget, unreadCount, lastPreview, label, nickname, lastActivityTs, onOpen, onDelete, onDeleteTarget, onClearDelete }: ContactItemProps) {
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnread = unreadCount > 0;
  const timeLabel = formatTimeAgo(lastActivityTs);
  return (
    <div className="sb-item-wrap"
      onTouchStart={() => { longPressRef.current = setTimeout(() => onDeleteTarget(c.email), 500); }}
      onTouchEnd={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onTouchMove={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onContextMenu={e => { e.preventDefault(); onDeleteTarget(c.email); }}>
      <button onClick={() => { if (isDeleteTarget) { onClearDelete(); return; } onOpen(); }}
        className={`sb-item ${isActive ? "sb-item--active" : ""} ${hasUnread && !isActive ? "sb-item--unread" : ""}`}>
        <div className="sb-av">
          {c.avatar_url ? <img src={c.avatar_url} alt="avatar" className="img-cover rounded-circle" /> : label?.[0]?.toUpperCase() || "?"}
          <span className={`pres ${c.is_online ? "pres--on" : ""}`}></span>
        </div>
        <div className="sb-item-body mw-0">
          <span className="sb-item-name name-row">
            {nickname ? (<><span>{nickname}</span><span className="name-meta">({c.display_name || (c.username ? `@${c.username}` : "")})</span></>) : <span>{label}</span>}
          </span>
          <span className={`sb-item-status text-truncate ${hasUnread ? "sb-item-status--unread" : ""}`}>
            {lastPreview ? lastPreview.substring(0, 34) + (lastPreview.length > 34 ? "…" : "") : c.username ? <span style={{ opacity: 0.5 }}>@{c.username}</span> : <span className={c.is_online ? "online" : ""}>{c.is_online ? "● Online" : "○ Offline"}</span>}
          </span>
        </div>
        <div className="sb-item-right">
          {timeLabel && <span className="sb-item-time">{timeLabel}</span>}
          {hasUnread && <span className="unread unread--dm" style={{ minWidth: 20, height: 20, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, padding: "0 5px" }}>{unreadCount}</span>}
        </div>
      </button>
      {isDeleteTarget && (
        <button className="sb-delete-btn" onClick={e => { e.stopPropagation(); onDelete(); }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></svg>Delete
        </button>
      )}
    </div>
  );
});

// ─── GROUP ITEM ───────────────────────────────────────────────────────────────
interface GroupItemProps {
  group: Group; isActive: boolean; isDeleteTarget: boolean;
  unreadCount: number; lastPreview: string; lastActivityTs: number;
  onOpen: () => void; onDelete: () => void; onDeleteTarget: (id: string) => void; onClearDelete: () => void;
}
const GroupItem = memo(function GroupItem({ group: g, isActive, isDeleteTarget, unreadCount, lastPreview, lastActivityTs, onOpen, onDelete, onDeleteTarget, onClearDelete }: GroupItemProps) {
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnread = unreadCount > 0;
  const sid = String(g.id);
  const timeLabel = formatTimeAgo(lastActivityTs);
  return (
    <div className="sb-item-wrap"
      onTouchStart={() => { longPressRef.current = setTimeout(() => onDeleteTarget(sid), 500); }}
      onTouchEnd={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onTouchMove={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onContextMenu={e => { e.preventDefault(); onDeleteTarget(sid); }}>
      <button onClick={() => { if (isDeleteTarget) { onClearDelete(); return; } onOpen(); }}
        className={`sb-item ${isActive ? "sb-item--active-group" : ""} ${hasUnread && !isActive ? "sb-item--unread" : ""}`}>
        <div className="sb-av sb-av--group">
          {g.avatar_url ? <img src={g.avatar_url} alt="group" className="img-cover rounded-circle" /> : g.name?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="sb-item-body mw-0">
          <span className="sb-item-name">{g.name}</span>
          <span className={`sb-item-status text-truncate ${hasUnread ? "sb-item-status--unread" : ""}`}>
            {lastPreview ? lastPreview.substring(0, 34) + (lastPreview.length > 34 ? "…" : "") : `${g.members.length} members`}
          </span>
        </div>
        <div className="sb-item-right">
          {timeLabel && <span className="sb-item-time">{timeLabel}</span>}
          {hasUnread && <span className="unread unread--secondary" style={{ minWidth: 20, height: 20, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, padding: "0 5px" }}>{unreadCount}</span>}
        </div>
      </button>
      {isDeleteTarget && (
        <button className="sb-delete-btn" onClick={e => { e.stopPropagation(); onDelete(); }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></svg>Delete
        </button>
      )}
    </div>
  );
});

// ─── MESSAGE BUBBLE ───────────────────────────────────────────────────────────
interface MessageBubbleProps {
  item: Message & { type: "msg" }; currentUser: string;
  isSelected: boolean; isEditing: boolean; editingText: string;
  reactionPickerId: string | number | null; chatType: "user" | "group";
  reactionEmojis: string[]; contacts: Contact[];
  isFailed: boolean;
  getPeerName: (email: string) => string; contactLabel: (c: Contact) => string;
  onReply: (msg: Message) => void;
  onEditStart: (id: string | number, text: string) => void;
  onEditSave: () => void; onEditCancel: () => void; onEditChange: (text: string) => void;
  onDelete: (id: string | number) => void;
  onReaction: (msgId: string | number, emoji: string) => void;
  onSetReactionPicker: (id: string | number | null) => void;
  onViewFile: (url: string, type: string) => void;
  onSelectMsg: (id: string | number | null) => void;
  onRetry: (msg: Message) => void;
}
const MessageBubble = memo(function MessageBubble({
  item, currentUser, isSelected, isEditing, editingText, reactionPickerId, chatType,
  reactionEmojis, contacts, isFailed, getPeerName, contactLabel,
  onReply, onEditStart, onEditSave, onEditCancel, onEditChange,
  onDelete, onReaction, onSetReactionPicker, onViewFile, onSelectMsg, onRetry,
}: MessageBubbleProps) {
  const isMine = item.user === currentUser;
  const formatTime = (ts: string) => parseTs(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const bubbleRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSwipingRef = useRef(false);
  const replyFired = useRef(false);
  const touchStartTime = useRef(0);
  const touchHandledClick = useRef(false);

  const [swipeX, setSwipeX] = useState(0);

  const clearPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const t = e.touches[0];
    touchStartX.current = t.clientX;
    touchStartY.current = t.clientY;
    touchStartTime.current = Date.now();
    isSwipingRef.current = false;
    replyFired.current = false;
    touchHandledClick.current = false;
    pressTimer.current = setTimeout(() => {
      if (!isSwipingRef.current) {
        touchHandledClick.current = true;
        onSetReactionPicker(reactionPickerId === item.id ? null : item.id);
      }
    }, 350);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartX.current;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      isSwipingRef.current = true;
      clearPress();
      const validSwipe = isMine ? dx < 0 : dx > 0;
      if (validSwipe) {
        const offset = Math.min(Math.abs(dx) * 0.55, 72);
        setSwipeX(offset);
        if (offset >= 55 && !replyFired.current) {
          replyFired.current = true;
          if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
          onReply(item);
        }
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    clearPress();
    setSwipeX(0);
    const target = e.target as HTMLElement;
    if (target.closest(".bubble-actions") || target.closest(".reaction-picker")) return;
    const elapsed = Date.now() - touchStartTime.current;
    if (!isSwipingRef.current && elapsed < 300) {
      touchHandledClick.current = true;
      const bw = e.currentTarget.closest(".bw");
      if (bw) {
        const rect = bw.getBoundingClientRect();
        const relX = touchStartX.current - rect.left;
        if (relX < rect.width * 0.25 || relX > rect.width * 0.75) {
          onSelectMsg(isSelected ? null : item.id);
          onSetReactionPicker(null);
        } else {
          onSelectMsg(isSelected ? null : item.id);
        }
      } else {
        onSelectMsg(isSelected ? null : item.id);
      }
    }
    isSwipingRef.current = false;
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (touchHandledClick.current) { touchHandledClick.current = false; return; }
    onSelectMsg(isSelected ? null : item.id);
    onSetReactionPicker(null);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSetReactionPicker(reactionPickerId === item.id ? null : item.id);
  };

  if (item._callRecord) {
    return (
      <div className="msg-row" style={{ justifyContent: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-full)", padding: "5px 14px", fontSize: 11, color: "var(--text-3)", userSelect: "none" }}>
          <span>{item.content}</span><span style={{ opacity: 0.5 }}>· {formatTime(item.timestamp)}</span>
        </div>
      </div>
    );
  }
  if (item.is_deleted) {
    return (
      <div className={`msg-row ${isMine ? "msg-mine" : "msg-theirs"}`}>
        <div className="msg-deleted">🚫 Message deleted</div>
      </div>
    );
  }
  if (isEditing) {
    return (
      <div className={`msg-row ${isMine ? "msg-mine" : "msg-theirs"}`}>
        <div className="edit-row">
          <input value={editingText} onChange={e => onEditChange(e.target.value)} onKeyDown={e => { if (e.key === "Enter") onEditSave(); if (e.key === "Escape") onEditCancel(); }} className="edit-field" autoFocus />
          <button onClick={onEditSave} className="edit-save">✓</button>
          <button onClick={onEditCancel} className="edit-discard">✕</button>
        </div>
      </div>
    );
  }

  const senderLabel = (() => {
    if (chatType !== "group" || isMine) return null;
    const c = contacts.find(c => c.email === item.user);
    return item.sender_name || (c ? contactLabel(c) : "Someone");
  })();
  const senderInitial = senderLabel ? senderLabel[0]?.toUpperCase() : "?";
  const senderContact = contacts.find(c => c.email === item.user);
  const showReplyIcon = swipeX > 20;
  const isPickerOpen = reactionPickerId === item.id;
  const isPending = String(item.id).startsWith("temp-") && !isFailed;

  return (
    <div className={`msg-row ${isMine ? "msg-mine" : "msg-theirs"}`}>
      <div
        className="msg-swipe-wrapper"
        style={{
          transform: swipeX > 0 ? `translateX(${isMine ? -swipeX : swipeX}px)` : undefined,
          transition: swipeX === 0 ? "transform 0.22s var(--ease-spring)" : "none",
        }}
      >
        {!isMine && (
          <div className={`swipe-reply-icon ${showReplyIcon ? "swipe-reply-icon--visible" : ""}`}>↩</div>
        )}

        {!isMine && chatType === "group" && (
          <div className="msg-sender-av">
            {senderContact?.avatar_url
              ? <img src={senderContact.avatar_url} alt="avatar" className="img-cover rounded-circle" />
              : senderInitial}
          </div>
        )}

        <div className={`bw relative-bw ${isSelected ? "bw--selected" : ""}`}>
          {senderLabel && <span className="sender-name">{senderLabel}</span>}

          <div
            ref={bubbleRef}
            className={`bubble ${isMine ? "mine" : "theirs"} ${isFailed ? "bubble--failed" : ""} ${isPending ? "bubble--pending" : ""}`}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
          >
            {item.reply_to_content && (
              <div className="quoted-message">
                <div className="quoted-bar"></div>
                <div className="quoted-text">{item.reply_to_content}</div>
              </div>
            )}

            {item.content.startsWith("[IMAGE]") ? (
              <img src={item.content.replace("[IMAGE]", "")} alt="attachment" className="msg-img msg-img-media" onClick={() => onViewFile(item.content.replace("[IMAGE]", ""), "image")} />
            ) : item.content.startsWith("[AUDIO]") ? (
              <audio src={item.content.replace("[AUDIO]", "")} controls className="msg-audio msg-audio-media" />
            ) : item.content.startsWith("[VIDEO]") ? (
              <video src={item.content.replace("[VIDEO]", "")} controls className="msg-video msg-video-media" onClick={() => onViewFile(item.content.replace("[VIDEO]", ""), "video")} />
            ) : item.content.startsWith("[PDF]") ? (
              <iframe src={item.content.replace("[PDF]", "")} className="msg-pdf msg-pdf-media" title="PDF" />
            ) : item.content.startsWith("[FILE]") ? (
              <a href={item.content.replace("[FILE]", "")} target="_blank" rel="noreferrer" className="msg-file-link">📄 Download file</a>
            ) : (
              <span className="msg-text">{item.content}</span>
            )}

            <div className="msg-footer">
              <span className="msg-ts">{formatTime(item.timestamp)}</span>
              {item.edited_at && <span className="msg-edited">edited</span>}
              {isMine && (
                <span className={`ticks ${item.is_read ? "ticks--read" : ""}`}>
                  {isFailed ? (
                    <button
                      className="retry-btn"
                      onMouseDown={e => { e.stopPropagation(); onRetry(item); }}
                      onTouchEnd={e => { e.stopPropagation(); onRetry(item); }}
                      title="Tap to retry"
                    >⚠️</button>
                  ) : isPending ? (
                    <span style={{ opacity: 0.5, fontSize: 9 }}>○</span>
                  ) : chatType === "user" ? (
                    item.is_read
                      ? <svg width="14" height="9" viewBox="0 0 22 14" fill="none"><path d="M1 7L6 12L15 1" stroke="currentColor" strokeWidth="2" /><path d="M8 7L13 12L22 1" stroke="currentColor" strokeWidth="2" /></svg>
                      : <svg width="10" height="9" viewBox="0 0 14 14" fill="none"><path d="M1 7L6 12L13 1" stroke="currentColor" strokeWidth="2" /></svg>
                  ) : (item.read_by && item.read_by.length > 0 && (
                    <span className="read-by-tooltip" title={`Read by:\n${item.read_by.map(e => getPeerName(e)).join("\n")}`}>
                      👁 {item.read_by.length}
                    </span>
                  ))}
                </span>
              )}
            </div>

            {item.reactions && Object.keys(item.reactions).length > 0 && (
              <div className="reactions-row">
                {Object.entries(item.reactions).map(([emoji, users]) => (
                  <span key={emoji} className={`reaction-pill ${users.includes(currentUser) ? "user-reacted" : ""}`} title={users.map(e => getPeerName(e)).join(", ")}>
                    {emoji}{users.length > 1 && ` ${users.length}`}
                  </span>
                ))}
              </div>
            )}

            {!isFailed && !isPending && (
              <div
                className={`bubble-actions ${isSelected ? "bubble-actions--visible" : ""}`}
                onClick={e => e.stopPropagation()}
                onMouseDown={e => e.stopPropagation()}
                onTouchStart={e => { e.stopPropagation(); clearPress(); }}
                onTouchMove={e => e.stopPropagation()}
                onTouchEnd={e => { e.stopPropagation(); touchHandledClick.current = true; }}
              >
                <button
                  onMouseDown={e => { e.stopPropagation(); onSetReactionPicker(isPickerOpen ? null : item.id); }}
                  onTouchEnd={e => { e.stopPropagation(); touchHandledClick.current = true; onSetReactionPicker(isPickerOpen ? null : item.id); }}
                  className="bubble-action-btn" title="React"
                >😀</button>
                <button
                  onMouseDown={e => { e.stopPropagation(); onReply(item); }}
                  onTouchEnd={e => { e.stopPropagation(); touchHandledClick.current = true; onReply(item); }}
                  className="bubble-action-btn" title="Reply"
                >↩</button>
                {isMine && (
                  <>
                    <button
                      onMouseDown={e => { e.stopPropagation(); onEditStart(item.id, item.content); }}
                      onTouchEnd={e => { e.stopPropagation(); touchHandledClick.current = true; onEditStart(item.id, item.content); }}
                      className="bubble-action-btn" title="Edit"
                    >✎</button>
                    <button
                      onMouseDown={e => { e.stopPropagation(); onDelete(item.id); }}
                      onTouchEnd={e => { e.stopPropagation(); touchHandledClick.current = true; onDelete(item.id); }}
                      className="bubble-action-btn del-action" title="Delete"
                    >🗑</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {isMine && (
          <div
            className={`swipe-reply-icon ${showReplyIcon ? "swipe-reply-icon--visible" : ""}`}
            style={{ left: "auto", right: "-32px" }}
          >↩</div>
        )}
      </div>

      {isPickerOpen && (
        <ReactionPickerPortal
          anchorRef={bubbleRef}
          isMine={isMine}
          emojis={reactionEmojis}
          onReact={emoji => { onReaction(item.id, emoji); onSetReactionPicker(null); onSelectMsg(null); }}
          onClose={() => onSetReactionPicker(null)}
        />
      )}
    </div>
  );
});

// ─── CONTACT PROFILE ──────────────────────────────────────────────────────────
interface ContactProfileProps {
  contact: Contact | undefined; activeChat: Chat; currentUser: string;
  nicknames: Record<string, string>; contactLabel: (c: Contact) => string;
  callLogs: CallLogEntry[]; messagesCache: Record<string, Message[]>;
  onClose: () => void; onCall: (video: boolean) => void;
  onNicknameEdit: () => void; getPeerName: (email: string) => string;
  onViewFile: (url: string, type: string) => void;
}
function ContactProfile({ contact: c, activeChat, currentUser, nicknames, contactLabel, callLogs, messagesCache, onClose, onCall, onNicknameEdit, getPeerName, onViewFile }: ContactProfileProps) {
  const [tab, setTab] = useState<ProfileTab>("info");
  const label = c ? contactLabel(c) : activeChat.name;
  const avatarUrl = c?.avatar_url;

  const sharedMedia = useMemo(() => {
    const msgs = messagesCache[String(activeChat.id)] || [];
    return msgs.filter(m => m.content.startsWith("[IMAGE]") || m.content.startsWith("[VIDEO]")).map(m => ({
      url: m.content.replace(/^\[IMAGE\]|\[VIDEO\]/, ""),
      type: m.content.startsWith("[IMAGE]") ? "image" : "video",
      ts: m.timestamp,
    }));
  }, [messagesCache, activeChat.id]);

  const myCallLogs = useMemo(() => callLogs.filter(l => l.peer === String(activeChat.id)), [callLogs, activeChat.id]);

  return (
    <div className="profile-fs-overlay" onClick={e => e.stopPropagation()}>
      <button className="pfs-back" onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
      </button>

      <div className="pfs-cover">
        <div className="pfs-cover-img" />
        <div className="pfs-cover-bg" />
        <div className="pfs-avatar" onClick={() => { if (avatarUrl) onViewFile(avatarUrl, "avatar-circle"); }}>
          {avatarUrl ? <img src={avatarUrl} alt="Profile" className="img-cover" /> : label?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="pfs-name">{label}</div>
        {c?.username && <div className="pfs-username">@{c.username}</div>}
        <div className={`pfs-status-badge ${c?.is_online ? "online" : "offline"}`}>
          <span className="pfs-dot" />
          {c?.is_online ? "Online" : "Offline"}
        </div>
      </div>

      <div className="pfs-actions">
        <button className="pfs-action-btn" onClick={() => onCall(false)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
          <span className="pfs-action-label">Voice</span>
        </button>
        <button className="pfs-action-btn" onClick={() => onCall(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
          <span className="pfs-action-label">Video</span>
        </button>
        <button className="pfs-action-btn" onClick={onNicknameEdit}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          <span className="pfs-action-label">Nickname</span>
        </button>
      </div>

      <div className="pfs-tabs">
        {(["info", "media", "calls"] as ProfileTab[]).map(t => (
          <button key={t} className={`pfs-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "info" ? "Info" : t === "media" ? "Media" : "Calls"}
          </button>
        ))}
      </div>

      <div className="pfs-tab-content">
        {tab === "info" && (
          <div className="pfs-info-section">
            {c?.username && (
              <div className="pfs-info-row">
                <div className="pfs-info-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M2 20c0-4 4-7 10-7s10 3 10 7" /></svg></div>
                <div><div className="pfs-info-label">Username</div><div className="pfs-info-val">@{c.username}</div></div>
              </div>
            )}
            <div className="pfs-info-row">
              <div className="pfs-info-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></svg></div>
              <div><div className="pfs-info-label">Email</div><div className="pfs-info-val">{String(activeChat.id)}</div></div>
            </div>
            <div className="pfs-info-row">
              <div className="pfs-info-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></div>
              <div style={{ flex: 1 }}><div className="pfs-info-label">Nickname</div><div className="pfs-info-val" style={{ color: nicknames[String(activeChat.id)] ? "#fff" : "rgba(255,255,255,0.35)" }}>{nicknames[String(activeChat.id)] || "Not set"}</div></div>
              <button className="cp-edit-btn pfs-info-edit" onClick={() => { onClose(); onNicknameEdit(); }}>{nicknames[String(activeChat.id)] ? "Edit" : "Add"}</button>
            </div>
          </div>
        )}

        {tab === "media" && (
          <div className="pfs-media-section">
            {sharedMedia.length === 0 ? (
              <div className="pfs-media-empty">📷 No shared media yet</div>
            ) : (
              <div className="pfs-media-grid">
                {sharedMedia.map((m, i) => (
                  <div key={i} className={`pfs-media-cell ${m.type === "video" ? "pfs-media-cell-vid" : ""}`} onClick={() => onViewFile(m.url, m.type)}>
                    {m.type === "image" ? <img src={m.url} alt="media" /> : <video src={m.url} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "calls" && (
          <div className="pfs-calls-section">
            {myCallLogs.length === 0 ? (
              <div className="pfs-calls-empty">📞 No calls with this contact</div>
            ) : myCallLogs.map(log => (
              <div key={log.id} className="pfs-call-item">
                <div className={`pfs-call-icon ${log.status === "missed" ? "missed" : log.direction}`}>
                  {log.media === "video"
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>}
                </div>
                <div className="pfs-call-info">
                  <div className={`pfs-call-dir ${log.status === "missed" ? "missed" : ""}`}>
                    {log.direction === "incoming" ? "↙ Incoming" : "↗ Outgoing"} {log.media === "video" ? "Video" : "Voice"}
                    {log.status !== "completed" && <span style={{ fontSize: "0.65rem", marginLeft: 6, opacity: 0.7 }}>({log.status})</span>}
                  </div>
                  <div className="pfs-call-meta">{parseTs(log.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                <div className="pfs-call-dur">{log.status === "completed" ? fmtDuration(log.duration) : log.status}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── GROUP PROFILE ────────────────────────────────────────────────────────────
interface GroupProfileProps {
  group: Group | undefined; activeChat: Chat; currentUser: string;
  contacts: Contact[]; contactLabel: (c: Contact) => string;
  callLogs: CallLogEntry[]; messagesCache: Record<string, Message[]>;
  newGroupMemberEmail: string; setNewGroupMemberEmail: (v: string) => void;
  isUploadingGroupAvatar: boolean; groupAvatarInputRef: React.RefObject<HTMLInputElement | null>;
  handleGroupAvatarUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void; onCall: (video: boolean) => void; onAddMember: () => void;
  onViewFile: (url: string, type: string) => void;
  getPeerName: (email: string) => string;
}
function GroupProfile({ group: g, activeChat, currentUser, contacts, contactLabel, callLogs, messagesCache, newGroupMemberEmail, setNewGroupMemberEmail, isUploadingGroupAvatar, groupAvatarInputRef, handleGroupAvatarUpload, onClose, onCall, onAddMember, onViewFile, getPeerName }: GroupProfileProps) {
  const [tab, setTab] = useState<ProfileTab>("members");
  if (!g) return null;
  const myMember = g.members.find(m => getEmail(m) === currentUser);
  const isAdmin = getIsAdmin(myMember) || g.members.length <= 1;

  const sharedMedia = useMemo(() => {
    const msgs = messagesCache[String(activeChat.id)] || [];
    return msgs.filter(m => m.content.startsWith("[IMAGE]") || m.content.startsWith("[VIDEO]")).map(m => ({
      url: m.content.replace(/^\[IMAGE\]|\[VIDEO\]/, ""),
      type: m.content.startsWith("[IMAGE]") ? "image" : "video",
    }));
  }, [messagesCache, activeChat.id]);

  const grpCallLogs = useMemo(() => callLogs.filter(l => l.peer === String(activeChat.id)), [callLogs, activeChat.id]);

  return (
    <div className="profile-fs-overlay" onClick={e => e.stopPropagation()}>
      <button className="pfs-back" onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
      </button>

      <div className="pfs-cover">
        <div className="pfs-cover-img" />
        <div className="pfs-cover-bg" />
        <div className="pfs-avatar" style={{ borderRadius: "var(--r-lg)" }} onClick={() => { if (g.avatar_url) onViewFile(g.avatar_url, "avatar-circle"); }}>
          {g.avatar_url ? <img src={g.avatar_url} alt="Group" className="img-cover" /> : g.name?.[0]?.toUpperCase() || "?"}
        </div>
        {isAdmin && (
          <>
            <input type="file" ref={groupAvatarInputRef} accept="image/*" className="hidden-input" onChange={handleGroupAvatarUpload} />
            <button className="avatar-upload-btn" style={{ zIndex: 2, position: "relative", width: "auto", padding: "4px 14px", marginTop: -4, fontSize: "0.72rem" }} disabled={isUploadingGroupAvatar} onClick={() => groupAvatarInputRef.current?.click()}>
              {isUploadingGroupAvatar ? "Uploading…" : "📷 Change photo"}
            </button>
          </>
        )}
        <div className="pfs-name">{g.name}</div>
        <div className="pfs-username">{g.members.length} members</div>
      </div>

      <div className="pfs-actions">
        <button className="pfs-action-btn" onClick={() => onCall(false)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
          <span className="pfs-action-label">Voice</span>
        </button>
        <button className="pfs-action-btn" onClick={() => onCall(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
          <span className="pfs-action-label">Video</span>
        </button>
      </div>

      <div className="pfs-tabs">
        {(["members", "media", "calls"] as ProfileTab[]).map(t => (
          <button key={t} className={`pfs-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "members" ? "Members" : t === "media" ? "Media" : "Calls"}
          </button>
        ))}
      </div>

      <div className="pfs-tab-content">
        {tab === "members" && (
          <div className="pfs-members-section">
            {g.members.map((mRaw, idx) => {
              const mEmail = getEmail(mRaw); const isAdm = getIsAdmin(mRaw);
              const c = contacts.find(c => c.email === mEmail);
              const lbl = c ? contactLabel(c) : mRaw?.display_name || (mRaw?.username ? `@${mRaw.username}` : "Unknown");
              return (
                <div key={`${mEmail}-${idx}`} className="pfs-member-item">
                  <div className="pfs-member-av">{c?.avatar_url ? <img src={c.avatar_url} className="img-cover rounded-circle" alt="avatar" /> : lbl?.[0]?.toUpperCase() || "?"}</div>
                  <div>
                    <div className="pfs-member-name">{lbl} {mEmail === currentUser ? "(You)" : ""}{isAdm && <span className="admin-badge"> Admin</span>}</div>
                    {c?.username && <div className="pfs-member-sub">@{c.username}</div>}
                  </div>
                </div>
              );
            })}
            {isAdmin && (
              <div className="pfs-add-member">
                <input value={newGroupMemberEmail} onChange={e => setNewGroupMemberEmail(e.target.value)} placeholder="Add member by email…" className="sb-field m-0 flex-grow" />
                <button className="cp-edit-btn ms-2" onClick={onAddMember}>Add</button>
              </div>
            )}
          </div>
        )}

        {tab === "media" && (
          <div className="pfs-media-section">
            {sharedMedia.length === 0 ? (
              <div className="pfs-media-empty">📷 No shared media yet</div>
            ) : (
              <div className="pfs-media-grid">
                {sharedMedia.map((m, i) => (
                  <div key={i} className={`pfs-media-cell ${m.type === "video" ? "pfs-media-cell-vid" : ""}`} onClick={() => onViewFile(m.url, m.type)}>
                    {m.type === "image" ? <img src={m.url} alt="media" /> : <video src={m.url} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "calls" && (
          <div className="pfs-calls-section">
            {grpCallLogs.length === 0 ? (
              <div className="pfs-calls-empty">📞 No group calls yet</div>
            ) : grpCallLogs.map(log => (
              <div key={log.id} className="pfs-call-item">
                <div className={`pfs-call-icon ${log.status === "missed" ? "missed" : log.direction}`}>
                  {log.media === "video"
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>}
                </div>
                <div className="pfs-call-info">
                  <div className={`pfs-call-dir ${log.status === "missed" ? "missed" : ""}`}>{log.direction === "incoming" ? "↙ Incoming" : "↗ Outgoing"} {log.media === "video" ? "Video" : "Voice"}</div>
                  <div className="pfs-call-meta">{parseTs(log.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                <div className="pfs-call-dur">{log.status === "completed" ? fmtDuration(log.duration) : log.status}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function PulseChat() {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").then(() => { idbSet("api_url", API); }).catch(() => { });
  }, []);

  const [auth, dispatchAuth] = useReducer(authReducer, authInit);
  const pendingSupabaseToken = useRef("");
  const [token, setToken] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem("chat_token") || "");
  const [currentUser, setCurrentUser] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem("chat_user") || "");
  const [profile, setProfile] = useState({ displayName: "", avatarUrl: "", username: "" });
  const isAuth = !!token;
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; if (token) idbSet("chat_token", token); }, [token]);
  const currentUserRef = useRef(currentUser);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
  useEffect(() => { if (typeof document !== "undefined") document.body.classList.toggle("auth-mode", !isAuth); }, [isAuth]);
  const abortControllerRef = useRef<AbortController>(new AbortController());

  // ── SUPABASE PASSWORD RECOVERY LISTENER ──────────────────────────────────
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        dispatchAuth({ type: "SET_STEP", step: "reset-password" });
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const [contacts, setContacts] = useState<Contact[]>(() => safeParseJSON<Contact[]>(typeof window !== "undefined" ? localStorage.getItem("cached_contacts") : null, []));
  const [groups, setGroups] = useState<Group[]>(() => safeParseJSON<Group[]>(typeof window !== "undefined" ? localStorage.getItem("cached_groups") : null, []));
  useDebouncedLocalStorage(contacts.length > 0 ? "cached_contacts" : "", contacts);
  useDebouncedLocalStorage(groups.length > 0 ? "cached_groups" : "", groups);

  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMsg, setInputMsg] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [lastActivity, setLastActivity] = useState<Record<string, number>>({});
  const [lastPreview, setLastPreview] = useState<Record<string, string>>({});
  const totalUnread = useMemo(() => Object.values(unread).reduce((sum, n) => sum + (n || 0), 0), [unread]);

  const [failedMsgIds, setFailedMsgIds] = useState<Set<string>>(new Set());
  const pendingTempTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastReplacedTempRef = useRef<string | null>(null);

  const [deletedMsgIds, setDeletedMsgIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    const u = localStorage.getItem("chat_user") || "";
    const saved = u ? localStorage.getItem(`deleted_msgs_${u}`) : null;
    return saved ? new Set<string>(safeParseJSON<string[]>(saved, [])) : new Set<string>();
  });
  const deletedMsgIdsRef = useRef(deletedMsgIds);
  useEffect(() => { deletedMsgIdsRef.current = deletedMsgIds; }, [deletedMsgIds]);
  useEffect(() => {
    if (!currentUser) return;
    const saved = localStorage.getItem(`deleted_msgs_${currentUser}`);
    const ids = saved ? new Set<string>(safeParseJSON<string[]>(saved, [])) : new Set<string>();
    setDeletedMsgIds(ids); deletedMsgIdsRef.current = ids;
  }, [currentUser]);

  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [typingSet, setTypingSet] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [reactionPickerId, setReactionPickerId] = useState<string | number | null>(null);
  const [selectedMsgId, setSelectedMsgId] = useState<string | number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [showEmojis, setShowEmojis] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showMyProfileSettings, setShowMyProfileSettings] = useState(false);
  const [showCallLogUI, setShowCallLogUI] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showNewContact, setShowNewContact] = useState(false);
  const [newContactUsername, setNewContactUsername] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [showGroupProfile, setShowGroupProfile] = useState(false);
  const [newGroupMemberEmail, setNewGroupMemberEmail] = useState("");
  const [isUploadingGroupAvatar, setIsUploadingGroupAvatar] = useState(false);
  const groupAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const [sidebarDeleteId, setSidebarDeleteId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [callState, setCallState] = useState<CallState>("idle");
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [callPeer, setCallPeer] = useState<string | null>(null);
  const [callPeerName, setCallPeerName] = useState<string>("");
  const [viewFile, setViewFile] = useState<{ url: string; type: string } | null>(null);
  const [callLogs, setCallLogs] = useState<CallLogEntry[]>(() => typeof window !== "undefined" ? safeParseJSON<CallLogEntry[]>(localStorage.getItem("cached_call_logs"), []) : []);
  const [showHeaderNicknameEdit, setShowHeaderNicknameEdit] = useState(false);
  const [headerNicknameValue, setHeaderNicknameValue] = useState("");
  const [showContactProfile, setShowContactProfile] = useState(false);
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaker, setIsSpeaker] = useState(true);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [pipPos, setPipPos] = useState({ x: 16, y: 100 });
  const pipDragging = useRef(false);
  const pipDragStart = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const [isVideoSwapped, setIsVideoSwapped] = useState(false);

  const notificationSoundRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const ringtonePlayPromise = useRef<Promise<void> | null>(null);
  const audioUnlockedRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    notificationSoundRef.current = new Audio("/notification.mp3"); notificationSoundRef.current.volume = 0.7; notificationSoundRef.current.preload = "auto";
    ringtoneRef.current = new Audio("/ringtone.mp3"); ringtoneRef.current.loop = true; ringtoneRef.current.volume = 1.0; ringtoneRef.current.preload = "auto";
    ringtoneRef.current.load(); notificationSoundRef.current.load();
    remoteAudioRef.current = new Audio(); remoteAudioRef.current.autoplay = true; remoteAudioRef.current.volume = 1.0;
  }, []);

  useEffect(() => {
    const unlock = () => {
      if (audioUnlockedRef.current) return;
      [notificationSoundRef.current, ringtoneRef.current].forEach(audio => { if (!audio) return; audio.play().then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => { }); });
      audioUnlockedRef.current = true;
    };
    const events = ["touchstart", "touchend", "mousedown", "keydown", "click"];
    events.forEach(e => document.addEventListener(e, unlock, { once: false, passive: true }));
    return () => events.forEach(e => document.removeEventListener(e, unlock));
  }, []);

  const playNotificationSound = useCallback(() => { const audio = notificationSoundRef.current; if (!audio) return; audio.currentTime = 0; audio.play().catch(() => { }); }, []);
  const startRingtone = useCallback(() => { const audio = ringtoneRef.current; if (!audio) return; audio.currentTime = 0; ringtonePlayPromise.current = audio.play().catch(() => { ringtonePlayPromise.current = new Promise(resolve => { setTimeout(() => { if (!ringtoneRef.current) { resolve(); return; } ringtoneRef.current.currentTime = 0; ringtoneRef.current.play().then(resolve).catch(() => resolve()); }, 500); }); }); }, []);
  const stopRingtone = useCallback(() => { const audio = ringtoneRef.current; if (!audio) return; const pending = ringtonePlayPromise.current; ringtonePlayPromise.current = null; const doStop = () => { audio.pause(); audio.currentTime = 0; }; if (pending) { pending.then(doStop).catch(doStop); } else { doStop(); } }, []);

  useEffect(() => { if (!currentUser) return; try { const saved = localStorage.getItem(`nicknames_${currentUser}`); setNicknames(saved ? JSON.parse(saved) : {}); } catch { setNicknames({}); } }, [currentUser]);
  useEffect(() => {
    if (!currentUser) return;
    const savedActivity = localStorage.getItem(`last_activity_${currentUser}`); if (savedActivity) { try { setLastActivity(JSON.parse(savedActivity)); } catch { } }
    const savedPreview = localStorage.getItem(`last_preview_${currentUser}`); if (savedPreview) { try { setLastPreview(JSON.parse(savedPreview)); } catch { } }
  }, [currentUser]);

  const msgListRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryDelay = useRef(1000);
  const wsPingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMessages = useRef<string[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingRemoteDescriptionRef = useRef<RTCSessionDescriptionInit | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const messagesCache = useRef<Record<string, Message[]>>({});
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const callStateRef = useRef<CallState>("idle");
  const callStartTimeRef = useRef<number | null>(null);
  const callDirectionRef = useRef<"incoming" | "outgoing" | null>(null);
  const activeChatRef = useRef<Chat | null>(activeChat);
  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);
  const isVideoCallRef = useRef(false);
  const isAppActiveRef = useRef(true);
  const seenMessageIds = useRef<Set<string>>(new Set<string>());
  const persistSeenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const ss = sessionStorage.getItem("pulse_seen_ids"); if (ss) { seenMessageIds.current = new Set<string>(JSON.parse(ss)); return; }
      const ls = localStorage.getItem("pulse_seen_ids_android"); if (ls) { const parsed = JSON.parse(ls) as { ids: string[]; ts: number }; if (Date.now() - parsed.ts < 30 * 60 * 1000) { seenMessageIds.current = new Set<string>(parsed.ids); } }
    } catch { }
  }, []);
  const fetchingProfilesRef = useRef<Set<string>>(new Set());
  const openChatRef = useRef<(chat: Chat) => void>(() => { });

  const updateCallState = useCallback((newState: CallState) => { setCallState(newState); callStateRef.current = newState; }, []);

  const persistSeenIds = useCallback(() => {
    if (persistSeenTimer.current) clearTimeout(persistSeenTimer.current);
    persistSeenTimer.current = setTimeout(() => {
      try {
        const arr = [...seenMessageIds.current].slice(-1000);
        sessionStorage.setItem("pulse_seen_ids", JSON.stringify(arr));
        localStorage.setItem("pulse_seen_ids_android", JSON.stringify({ ids: arr, ts: Date.now() }));
      } catch { }
    }, 500);
  }, []);

  const updateActivity = useCallback((chatId: string | number, content: string) => {
    const id = String(chatId); const now = Date.now();
    setLastActivity(prev => { const next = { ...prev, [id]: now }; if (currentUserRef.current) localStorage.setItem(`last_activity_${currentUserRef.current}`, JSON.stringify(next)); return next; });
    if (content && !content.startsWith("["))
      setLastPreview(prev => { const next = { ...prev, [id]: content }; if (currentUserRef.current) localStorage.setItem(`last_preview_${currentUserRef.current}`, JSON.stringify(next)); return next; });
  }, []);

  const apiFetch = useCallback(async<T,>(path: string, opts: ApiOptions = {}): Promise<T> => {
    const headers = new Headers(opts.headers as HeadersInit | undefined);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    headers.set("ngrok-skip-browser-warning", "true");
    if (tokenRef.current) headers.set("Authorization", `Bearer ${tokenRef.current}`);
    const signal = opts.signal ?? abortControllerRef.current.signal;
    const res = await fetch(`${API}${path}`, { ...opts, headers, signal });
    if (!res.ok) { const body = await res.json().catch(() => ({ detail: "Request failed" })); throw new Error(body.detail || "Request failed"); }
    return res.json();
  }, []);

  useEffect(() => {
    if (!token) return;
    apiFetch<Record<string, number>>("/unread-counts")
      .then(counts => { const id = activeChatRef.current ? String(activeChatRef.current.id) : null; const merged = id ? { ...counts, [id]: 0 } : counts; setUnread(merged); try { localStorage.setItem("cached_unread", JSON.stringify(merged)); } catch { } })
      .catch(() => { const cached = safeParseJSON<Record<string, number>>(localStorage.getItem("cached_unread"), {}); setUnread(cached); });
  }, [token]); // eslint-disable-line

  useEffect(() => {
    if (!token) return;
    apiFetch<CallLogEntry[]>("/call-logs").then(apiLogs => {
      setCallLogs(prev => { const apiIdSet = new Set(apiLogs.map(l => l.id)); const localOnly = prev.filter(l => !apiIdSet.has(l.id)); const merged = [...apiLogs, ...localOnly]; merged.sort((a, b) => parseTs(b.timestamp).getTime() - parseTs(a.timestamp).getTime()); const final = merged.slice(0, 200); try { localStorage.setItem("cached_call_logs", JSON.stringify(final)); } catch { } return final; });
    }).catch(() => { });
  }, [token]); // eslint-disable-line

  const loadProfile = useCallback(async () => {
    try { const data = await apiFetch<{ display_name: string; avatar_url: string; username: string }>("/profile/me"); setProfile({ displayName: data.display_name || "", avatarUrl: data.avatar_url || "", username: data.username || "" }); setEditDisplayName(data.display_name || ""); setEditUsername(data.username || ""); } catch { }
  }, [apiFetch]);

  const loadContacts = useCallback(async () => { try { setContacts(await apiFetch<Contact[]>("/contacts")); } catch { } }, [apiFetch]);
  const loadGroups = useCallback(async () => {
    try { const gs = await apiFetch<Group[]>("/groups"); const withAvatars = gs.map(g => { const saved = typeof window !== "undefined" ? localStorage.getItem(`group_avatar_${g.id}`) : null; return saved ? { ...g, avatar_url: saved } : g; }); setGroups(withAvatars); } catch { }
  }, [apiFetch]);

  const scrollBottom = useCallback(() => { if (msgListRef.current) msgListRef.current.scrollTop = msgListRef.current.scrollHeight; }, []);
  const applyPersistedDeletions = useCallback((msgs: Message[]): Message[] => { const ids = deletedMsgIdsRef.current; if (ids.size === 0) return msgs; return msgs.map(m => ids.has(String(m.id)) ? { ...m, is_deleted: true } : m); }, []);

  const loadHistory = useCallback(async (chat: Chat, beforeId: string | number | null = null) => {
    if (!chat) return; setLoadingMore(true);
    try {
      const { type, id } = chat;
      const base = type === "user" ? `/messages/direct/${encodeURIComponent(id)}` : `/messages/group/${id}`;
      const rawHistory = await apiFetch<Message[]>(base + (beforeId ? `?before_id=${beforeId}` : ""));
      const history = applyPersistedDeletions(rawHistory);
      if (beforeId) {
        const list = msgListRef.current; const prevScrollHeight = list ? list.scrollHeight : 0;
        setMessages(prev => { const next = [...history, ...prev]; messagesCache.current[String(chat.id)] = next; return next; });
        requestAnimationFrame(() => { if (list) list.scrollTop = list.scrollHeight - prevScrollHeight; });
      } else {
        setMessages(history); messagesCache.current[String(chat.id)] = history;
        if (history.length > 0) updateActivity(id, history[history.length - 1].content);
        setTimeout(scrollBottom, 100);
      }
      setHasMore(history.length === 50);
    } catch { }
    setLoadingMore(false);
  }, [apiFetch, scrollBottom, updateActivity, applyPersistedDeletions]);

  const notify = useCallback((title: string, body: string, chatId?: string) => {
    if (typeof window === "undefined") return;
    if (chatId && activeChatRef.current && String(activeChatRef.current.id) === chatId) return;
    playNotificationSound();
    if (isAppActiveRef.current && document.hasFocus()) return;
    if (Notification.permission !== "granted") return;
    if ("serviceWorker" in navigator) { navigator.serviceWorker.ready.then(reg => { reg.showNotification(title, { body, icon: "/favicon.ico", badge: "/favicon.ico", vibrate: [200, 100, 200], tag: "pulse-msg", renotify: true } as any); }).catch(() => { const n = new Notification(title, { body, icon: "/favicon.ico" }); setTimeout(() => n.close(), 5000); }); }
    else { const n = new Notification(title, { body, icon: "/favicon.ico" }); setTimeout(() => n.close(), 5000); }
  }, [playNotificationSound]);

  const notifyCall = useCallback((title: string, body: string) => {
    if (typeof window === "undefined") return;
    if (Notification.permission !== "granted") return;
    if ("serviceWorker" in navigator) { navigator.serviceWorker.ready.then(reg => { reg.showNotification(title, { body, icon: "/favicon.ico", badge: "/favicon.ico", vibrate: [300, 100, 300, 100, 300], tag: "pulse-call", renotify: true } as any); }).catch(() => { const n = new Notification(title, { body, icon: "/favicon.ico" }); setTimeout(() => n.close(), 30000); }); }
    else { const n = new Notification(title, { body, icon: "/favicon.ico" }); setTimeout(() => n.close(), 30000); }
  }, []);

  const markAllRead = useCallback(() => { setUnread({}); try { localStorage.setItem("cached_unread", JSON.stringify({})); } catch { } }, []);
  const contactLabelFn = useCallback((c: Contact) => nicknames[c.email] || c.display_name || (c.username ? `@${c.username}` : null) || "Unknown User", [nicknames]);
  const contactLabel = contactLabelFn;
  const getPeerName = useCallback((email: string) => { const c = contacts.find(c => c.email === email); return c ? contactLabelFn(c) : "Unknown User"; }, [contacts, contactLabelFn]);
  const applyAudioOutput = useCallback((speaker: boolean) => { const targets: Array<HTMLAudioElement | HTMLVideoElement | null> = [remoteAudioRef.current, remoteVideoRef.current]; targets.forEach(el => { if (!el) return; if ("setSinkId" in el) (el as any).setSinkId(speaker ? "" : "communications").catch(() => { }); el.volume = 1.0; }); }, []);

  // ── AUTH HANDLERS ─────────────────────────────────────────────────────────
  const handleSignIn = async () => {
    dispatchAuth({ type: "SET_ERROR", value: "" }); dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: auth.email.trim(), password: auth.pass });
      if (error) throw error;
      const idToken = data.session?.access_token; if (!idToken) throw new Error("No session token");
      const res = await apiFetch<{ access_token: string; user: any }>("/auth/login", { method: "POST", body: JSON.stringify({ id_token: idToken }) });
      _finalizeAuth(res.access_token, res.user.email);
    } catch (e: any) {
      if (e.message?.includes("Account not found")) { const { data } = await supabase.auth.getSession(); pendingSupabaseToken.current = data.session?.access_token || ""; dispatchAuth({ type: "SET_STEP", step: "pick-username" }); }
      else { dispatchAuth({ type: "SET_ERROR", value: e.message || "Sign in failed" }); }
    } finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const handleSignUp = async () => {
    if (auth.pass !== auth.pass2) { dispatchAuth({ type: "SET_ERROR", value: "Passwords don't match" }); return; }
    if (auth.pass.length < 6) { dispatchAuth({ type: "SET_ERROR", value: "Password must be at least 6 characters" }); return; }
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const { data, error } = await supabase.auth.signUp({ email: auth.email.trim(), password: auth.pass });
      if (error) throw error;
      const t = data.session?.access_token;
      if (!t) { dispatchAuth({ type: "SET_STEP", step: "verify-email" }); return; }
      pendingSupabaseToken.current = t; dispatchAuth({ type: "SET_STEP", step: "pick-username" });
    } catch (e: any) { dispatchAuth({ type: "SET_ERROR", value: e.message || "Sign up failed" }); }
    finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const handleRegister = async () => {
    const username = auth.user.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) { dispatchAuth({ type: "SET_ERROR", value: "Username must be 3–30 chars: lowercase letters, numbers, underscores only" }); return; }
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      if (!pendingSupabaseToken.current) { const { data } = await supabase.auth.getSession(); pendingSupabaseToken.current = data.session?.access_token || ""; if (!pendingSupabaseToken.current) { dispatchAuth({ type: "SET_ERROR", value: "Session expired" }); dispatchAuth({ type: "SET_STEP", step: "signin" }); return; } }
      const res = await apiFetch<{ access_token: string; user: any }>("/auth/register", { method: "POST", body: JSON.stringify({ id_token: pendingSupabaseToken.current, username, display_name: auth.user.trim() }) });
      _finalizeAuth(res.access_token, res.user.email);
    } catch (e: any) { dispatchAuth({ type: "SET_ERROR", value: e.message || "Registration failed" }); }
    finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  // ── FORGOT PASSWORD ───────────────────────────────────────────────────────
  const handleForgotPassword = async () => {
    if (!auth.email.trim()) { dispatchAuth({ type: "SET_ERROR", value: "Enter your email first" }); return; }
    dispatchAuth({ type: "SET_ERROR", value: "" }); dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const redirectTo = typeof window !== "undefined"
        ? window.location.origin
        : "com.yourapp://reset"; // ← change to your Android deep link scheme
      const { error } = await supabase.auth.resetPasswordForEmail(auth.email.trim(), { redirectTo });
      if (error) throw error;
      dispatchAuth({ type: "SET_STEP", step: "verify-email" });
    } catch (e: any) {
      dispatchAuth({ type: "SET_ERROR", value: e.message || "Failed to send reset email" });
    } finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  // ── RESET PASSWORD (called after user clicks email link) ──────────────────
  const handleResetPassword = async () => {
    if (auth.pass !== auth.pass2) { dispatchAuth({ type: "SET_ERROR", value: "Passwords don't match" }); return; }
    if (auth.pass.length < 6) { dispatchAuth({ type: "SET_ERROR", value: "Password must be at least 6 characters" }); return; }
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const { error } = await supabase.auth.updateUser({ password: auth.pass });
      if (error) throw error;
      dispatchAuth({ type: "RESET" });
      dispatchAuth({ type: "SET_STEP", step: "signin" });
      alert("Password updated! Sign in with your new password.");
    } catch (e: any) {
      dispatchAuth({ type: "SET_ERROR", value: e.message || "Reset failed" });
    } finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const _finalizeAuth = (accessToken: string, email: string) => {
    setToken(accessToken); setCurrentUser(email);
    localStorage.setItem("chat_token", accessToken); localStorage.setItem("chat_user", email);
    idbSet("chat_token", accessToken); pendingSupabaseToken.current = "";
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  };

  const logout = () => {
    abortControllerRef.current.abort(); abortControllerRef.current = new AbortController();
    pendingTempTimers.current.forEach(t => clearTimeout(t));
    pendingTempTimers.current.clear();
    setFailedMsgIds(new Set());
    stopRingtone(); supabase.auth.signOut().catch(() => { });
    setToken(""); setCurrentUser(""); setMessages([]); setActiveChat(null); setContacts([]); setGroups([]); setUnread({});
    setProfile({ displayName: "", avatarUrl: "", username: "" }); setNicknames({}); setLastActivity({}); setLastPreview({});
    dispatchAuth({ type: "RESET" }); setShowHeaderNicknameEdit(false); setShowContactProfile(false);
    setShowGroupProfile(false); setShowMyProfileSettings(false); setSearchQuery("");
    localStorage.removeItem("chat_token"); localStorage.removeItem("chat_user");
    localStorage.removeItem("cached_contacts"); localStorage.removeItem("cached_groups");
    localStorage.removeItem("cached_unread"); localStorage.removeItem("cached_call_logs");
    localStorage.removeItem("pulse_seen_ids_android");
    try { sessionStorage.removeItem("pulse_seen_ids"); } catch { }
    idbSet("chat_token", "");
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    setWsStatus("disconnected"); seenMessageIds.current.clear();
  };

  const saveProfile = async () => {
    try {
      const body: any = {};
      if (editDisplayName.trim()) body.display_name = editDisplayName.trim();
      if (editUsername.trim() && editUsername.trim() !== profile.username) { const u = editUsername.trim().toLowerCase(); if (!USERNAME_RE.test(u)) { alert("Invalid username format"); return; } body.username = u; }
      await apiFetch("/profile/me", { method: "PATCH", body: JSON.stringify(body) });
      setProfile(prev => ({ ...prev, displayName: editDisplayName.trim() || prev.displayName, username: body.username || prev.username }));
      setShowProfile(false); await loadProfile();
    } catch (err) { alert("Failed to save profile: " + errorMessage(err)); }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return; setIsUploadingAvatar(true);
    const form = new FormData(); form.append("file", file);
    try { const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form }); if (!res.ok) throw new Error("Upload failed"); const data = await res.json(); await apiFetch("/profile/me", { method: "PATCH", body: JSON.stringify({ avatar_url: data.url }) }); setProfile(prev => ({ ...prev, avatarUrl: data.url })); } catch { alert("Avatar upload failed"); }
    finally { setIsUploadingAvatar(false); }
  };

  const handleGroupAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeChat || activeChat.type !== "group") return;
    const file = e.target.files?.[0]; if (!file) return; setIsUploadingGroupAvatar(true);
    const form = new FormData(); form.append("file", file);
    try { const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form }); if (!res.ok) throw new Error("Upload failed"); const data = await res.json(); localStorage.setItem(`group_avatar_${activeChat.id}`, data.url); setGroups(prev => prev.map(g => g.id === activeChat.id ? { ...g, avatar_url: data.url } : g)); } catch (err) { alert("Group avatar upload failed: " + errorMessage(err)); }
    finally { setIsUploadingGroupAvatar(false); e.target.value = ""; }
  };

  const addGroupMember = async () => {
    if (!activeChat || activeChat.type !== "group" || !newGroupMemberEmail.trim()) return;
    try { await apiFetch(`/groups/${activeChat.id}/members?member_email=${encodeURIComponent(newGroupMemberEmail.trim())}`, { method: "POST" }); setNewGroupMemberEmail(""); await loadGroups(); }
    catch (err) { alert("Failed to add member: " + errorMessage(err)); }
  };

  const addContactByUsername = async (username: string) => {
    if (!username.trim()) return;
    try { const res = await apiFetch<{ email: string; username: string; message: string }>("/contacts", { method: "POST", body: JSON.stringify({ username: username.trim().toLowerCase() }) }); await loadContacts(); const prof = await apiFetch<Contact>(`/profile/by-username/${username.trim().toLowerCase()}`); openChat({ type: "user", id: res.email, name: prof.display_name || prof.username || "Unknown User" }); }
    catch (err) { alert("Could not find user: " + errorMessage(err)); }
  };

  const saveContactNickname = (email: string, nickname: string) => {
    const trimmed = nickname.trim();
    setNicknames(prev => { const next = { ...prev }; if (trimmed) next[email] = trimmed; else delete next[email]; if (currentUser) localStorage.setItem(`nicknames_${currentUser}`, JSON.stringify(next)); return next; });
    setActiveChat(prev => { if (prev?.type === "user" && prev.id === email) { const c = contacts.find(c => c.email === email); return { ...prev, name: trimmed || c?.display_name || c?.username || "Unknown User" }; } return prev; });
    setShowHeaderNicknameEdit(false);
  };

  const openHeaderNicknameEdit = () => {
    if (!activeChat || activeChat.type !== "user") return;
    setHeaderNicknameValue(nicknames[String(activeChat.id)] || ""); setShowHeaderNicknameEdit(true);
    setShowContactProfile(false);
  };

  const deleteChat = useCallback((type: "user" | "group", id: string | number) => {
    const sid = String(id); setSidebarDeleteId(null);
    delete messagesCache.current[sid];
    setLastActivity(prev => { const n = { ...prev }; delete n[sid]; return n; });
    setLastPreview(prev => { const n = { ...prev }; delete n[sid]; return n; });
    setUnread(prev => { const n = { ...prev }; delete n[sid]; return n; });
    if (type === "user") setContacts(prev => prev.filter(c => c.email !== sid));
    else setGroups(prev => prev.filter(g => String(g.id) !== sid));
    if (activeChat && String(activeChat.id) === sid) { setActiveChat(null); setMessages([]); }
    const endpoint = type === "user" ? `/conversations/user/${encodeURIComponent(sid)}` : `/conversations/group/${sid}`;
    apiFetch(endpoint, { method: "DELETE" }).catch(() => { });
  }, [activeChat, apiFetch]);

  const sendReadReceipt = useCallback(async (chat: Chat) => {
    const chatId = String(chat.id);
    if (chat.type !== "user") return;
    try {
      await apiFetch(`/mark-read`, { method: "POST", body: JSON.stringify({ peer_email: chatId }) });
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "read_receipt", target_user: chatId }));
      }
    } catch {
      setTimeout(async () => {
        try {
          await apiFetch(`/mark-read`, { method: "POST", body: JSON.stringify({ peer_email: chatId }) });
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "read_receipt", target_user: chatId }));
          }
        } catch { }
      }, 3000);
    }
  }, [apiFetch]);

  const openChat = useCallback(async (chat: Chat) => {
    const chatId = String(chat.id);
    setActiveChat(chat); setShowHeaderNicknameEdit(false); setShowContactProfile(false);
    setShowGroupProfile(false); setSearchQuery(""); setReplyingTo(null);
    setReactionPickerId(null); setSelectedMsgId(null); setSidebarDeleteId(null);
    if (messagesCache.current[chatId]) { setMessages(messagesCache.current[chatId]); setTimeout(scrollBottom, 10); }
    else { setMessages([]); }
    setHasMore(false); setShowEmojis(false); setEditingId(null);
    setUnread(prev => { const next = { ...prev, [chatId]: 0 }; try { localStorage.setItem("cached_unread", JSON.stringify(next)); } catch { } return next; });
    sendReadReceipt(chat);
    if (chat.type === "group") {
      apiFetch(`/mark-read`, { method: "POST", body: JSON.stringify({ group_id: chatId }) }).catch(() => { });
    }
    await loadHistory(chat);
    setMessages(prev => { const next = prev.map(m => m.user !== currentUser && !m.is_read ? { ...m, is_read: true } : m); messagesCache.current[chatId] = next; return next; });
  }, [scrollBottom, loadHistory, apiFetch, currentUser, sendReadReceipt]);
  useEffect(() => { openChatRef.current = openChat; }, [openChat]);

  useEffect(() => {
    const anyOverlayOpen = showEmojis || showContactProfile || showGroupProfile || showCallLogUI || showProfile || showMyProfileSettings || !!viewFile || reactionPickerId !== null;
    if (anyOverlayOpen) window.history.pushState({ pulseOverlay: true }, "");
    const handlePopState = () => {
      if (showEmojis) { setShowEmojis(false); return; } if (reactionPickerId !== null) { setReactionPickerId(null); return; } if (viewFile) { setViewFile(null); return; }
      if (showContactProfile) { setShowContactProfile(false); return; } if (showGroupProfile) { setShowGroupProfile(false); return; }
      if (showCallLogUI) { setShowCallLogUI(false); return; } if (showProfile) { setShowProfile(false); return; }
      if (showMyProfileSettings) { setShowMyProfileSettings(false); return; } if (activeChat) { setActiveChat(null); return; }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [showEmojis, showContactProfile, showGroupProfile, showCallLogUI, showProfile, showMyProfileSettings, viewFile, reactionPickerId, activeChat]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current; if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting && !loadingMore && messages.length > 0 && activeChat) loadHistory(activeChat, messages[0].id); }, { root: msgListRef.current, threshold: 0, rootMargin: "80px 0px 0px 0px" });
    observer.observe(sentinel); return () => observer.disconnect();
  }, [hasMore, loadingMore, messages, activeChat, loadHistory]);

  const wsSend = useCallback((payload: string) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(payload); else pendingMessages.current.push(payload); }, []);
  const initWSRef = useRef<(() => void) | null>(null);

  const endCall = useCallback((sendSignal = true, explicitStatus?: "completed" | "missed" | "rejected") => {
    stopRingtone();
    const finalStatus = explicitStatus || (callStateRef.current === "connected" ? "completed" : "missed");
    const duration = callStartTimeRef.current && callStateRef.current === "connected" ? Math.floor((Date.now() - callStartTimeRef.current) / 1000) : 0;
    if (callPeer && callDirectionRef.current) {
      const resolvedName = callPeerName || getPeerName(callPeer) || callPeer;
      const newLog: CallLogEntry = { id: Date.now().toString() + Math.random(), peer: callPeer, peerName: resolvedName, direction: callDirectionRef.current, media: isVideoCallRef.current ? "video" : "audio", status: finalStatus, timestamp: new Date().toISOString(), duration };
      setCallLogs(prev => { const next = [newLog, ...prev]; try { localStorage.setItem("cached_call_logs", JSON.stringify(next.slice(0, 200))); } catch { } return next; });
      apiFetch("/call-logs", { method: "POST", body: JSON.stringify({ id: newLog.id, peer: newLog.peer, peerName: newLog.peerName, direction: newLog.direction, media: newLog.media, status: newLog.status, timestamp: newLog.timestamp, duration: newLog.duration }) }).catch(() => { });
      const icon = isVideoCallRef.current ? "📹" : "📞";
      const callTypeLabel = isVideoCallRef.current ? "Video call" : "Voice call";
      const statusLabel = finalStatus === "completed" ? ` · ${fmtDuration(duration)}` : finalStatus === "rejected" ? " · Declined" : " · Missed";
      const dirLabel = callDirectionRef.current === "incoming" ? "Incoming" : "Outgoing";
      const recordContent = `${icon} ${dirLabel} ${callTypeLabel}${statusLabel}`;
      const callRecord: Message = { id: `call-${Date.now()}-${Math.random()}`, user: currentUserRef.current, content: recordContent, timestamp: new Date().toISOString(), _callRecord: true };
      const targetChatId = activeChatRef.current ? String(activeChatRef.current.id) : callPeer;
      setMessages(prev => { const next = [...prev, callRecord]; messagesCache.current[targetChatId] = next; return next; });
      setTimeout(scrollBottom, 50);
    }
    if (sendSignal && wsRef.current?.readyState === WebSocket.OPEN) {
      if (pcMapRef.current.size > 0) { pcMapRef.current.forEach((_, peerEmail) => wsRef.current!.send(JSON.stringify({ type: "call_end", target_user: peerEmail }))); }
      else if (callPeer) { wsRef.current.send(JSON.stringify({ type: "call_end", target_user: callPeer })); }
    }
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
    pcMapRef.current.forEach(pc => pc.close()); pcMapRef.current.clear();
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    peerConnectionRef.current = null; pendingRemoteDescriptionRef.current = null;
    localStreamRef.current = null; remoteStreamRef.current = null; iceCandidateQueueRef.current = [];
    setRemoteStreams({}); updateCallState("idle"); setCallPeer(null); setCallPeerName("");
    setIsMuted(false); setIsSpeaker(true); setFacingMode("user"); setCallDuration(0); setIsVideoSwapped(false);
    callStartTimeRef.current = null; callDirectionRef.current = null; isVideoCallRef.current = false; setPipPos({ x: 16, y: 100 });
  }, [callPeer, callPeerName, updateCallState, stopRingtone, scrollBottom, getPeerName, apiFetch]); // eslint-disable-line

  const initWS = useCallback(() => {
    if (wsPingInterval.current) { clearInterval(wsPingInterval.current); wsPingInterval.current = null; }
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    const currentToken = tokenRef.current; if (!currentToken) return;
    setWsStatus("reconnecting");
    const ws = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(currentToken)}`);
    wsRef.current = ws;
    ws.onopen = () => {
      wsRetryDelay.current = 1000; setWsStatus("connected");
      if (seenMessageIds.current.size > 2000) { const arr = [...seenMessageIds.current].slice(-1000); seenMessageIds.current = new Set(arr); }
      persistSeenIds();
      wsPingInterval.current = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 25000);
      while (pendingMessages.current.length > 0) { const queued = pendingMessages.current.shift(); if (queued && ws.readyState === WebSocket.OPEN) ws.send(queued); }
      apiFetch<Record<string, number>>("/unread-counts").then(counts => {
        const id = activeChatRef.current ? String(activeChatRef.current.id) : null;
        setUnread(() => { const merged = { ...counts }; if (id) merged[id] = 0; try { localStorage.setItem("cached_unread", JSON.stringify(merged)); } catch { } return merged; });
      }).catch(() => { });
      const openChatNow = activeChatRef.current;
      if (openChatNow?.type === "user" && ws.readyState === WebSocket.OPEN) {
        apiFetch("/mark-read", { method: "POST", body: JSON.stringify({ peer_email: String(openChatNow.id) }) })
          .then(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "read_receipt", target_user: openChatNow.id })); })
          .catch(() => { });
      }
    };
    ws.onclose = () => {
      if (wsPingInterval.current) { clearInterval(wsPingInterval.current); wsPingInterval.current = null; }
      setWsStatus("disconnected");
      if (!tokenRef.current) return;
      setTimeout(() => { wsRetryDelay.current = Math.min(wsRetryDelay.current * 2, 30000); setWsStatus("reconnecting"); initWSRef.current?.(); }, wsRetryDelay.current);
    };
    ws.onmessage = async ({ data: raw }) => {
      let data: Partial<Message> & Record<string, unknown>; try { data = JSON.parse(raw); } catch { return; }
      if (data.type === "pong") return;
      const me = currentUserRef.current;
      switch (data.type) {
        case "typing":
          if (typeof data.user === "string" && data.user !== me) { setTypingSet(prev => new Set(prev).add(data.user as string)); setTimeout(() => setTypingSet(prev => { const n = new Set(prev); n.delete(data.user as string); return n; }), 2000); }
          break;
        case "direct_message": {
          setTypingSet(prev => { const n = new Set(prev); n.delete(String(data.user)); return n; });
          const peer = data.user === me ? (data.receiver_email || data.target_user) : data.user; if (!peer) break;
          const msg = data as Message; const dmId = String(msg.id);
          if (!dmId.startsWith("temp-") && seenMessageIds.current.has(dmId)) break;
          if (!dmId.startsWith("temp-")) { seenMessageIds.current.add(dmId); persistSeenIds(); }
          updateActivity(String(peer), msg.content);
          if (data.user !== me) {
            const peerEmail = String(peer);
            setContacts(prev => {
              if (prev.find(c => c.email === peerEmail)) return prev;
              return [...prev, { email: peerEmail, display_name: (data.sender_name as string) || null, avatar_url: (data.sender_avatar as string) || null, is_online: true, username: null }];
            });
            apiFetch("/contacts/by-email", { method: "POST", body: JSON.stringify({ email: peerEmail }) })
              .then(() => loadContacts())
              .catch(() => setTimeout(() => loadContacts(), 2000));
            if (!fetchingProfilesRef.current.has(peerEmail)) {
              fetchingProfilesRef.current.add(peerEmail);
              apiFetch<Contact>(`/profile/${encodeURIComponent(peerEmail)}`)
                .then(prof => setContacts(prev => prev.map(c => c.email === peerEmail ? { ...c, ...prof } : c)))
                .catch(() => { })
                .finally(() => fetchingProfilesRef.current.delete(peerEmail));
            }
          }
          const currentActiveDM = activeChatRef.current;
          const isInPeerChat = currentActiveDM?.type === "user" && String(currentActiveDM.id) === String(peer);
          if (isInPeerChat) {
            lastReplacedTempRef.current = null;
            setMessages(prev => {
              let next = prev;
              if (data.user === me) {
                const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
                if (idx !== -1) { lastReplacedTempRef.current = String(prev[idx].id); next = [...prev]; next[idx] = msg; }
                else if (!prev.find(m => String(m.id) === String(msg.id))) next = [...prev, msg];
              } else if (!prev.find(m => String(m.id) === String(msg.id))) next = [...prev, msg];
              messagesCache.current[String(peer)] = next; return next;
            });
            const replacedId = lastReplacedTempRef.current;
            if (replacedId) { const t = pendingTempTimers.current.get(replacedId); if (t) { clearTimeout(t); pendingTempTimers.current.delete(replacedId); } setFailedMsgIds(prev => { const n = new Set(prev); n.delete(replacedId); return n; }); }
            setTimeout(scrollBottom, 50);
            if (data.user !== me && currentActiveDM) sendReadReceipt(currentActiveDM);
          } else if (data.user !== me) {
            setUnread(prev => { const next = { ...prev, [String(peer)]: (prev[String(peer)] || 0) + 1 }; try { localStorage.setItem("cached_unread", JSON.stringify(next)); } catch { } return next; });
            notify((data.sender_name as string) || "New message", msg.content.startsWith("[") ? "📎 Attachment" : msg.content, String(peer));
          }
          break;
        }
        case "group_message": {
          updateActivity(String(data.group_id), String(data.content || ""));
          const gmId = String((data as any).id);
          if (gmId && !gmId.startsWith("temp-") && seenMessageIds.current.has(gmId)) break;
          if (gmId && !gmId.startsWith("temp-")) { seenMessageIds.current.add(gmId); persistSeenIds(); }
          const currentActiveGrp = activeChatRef.current;
          const isInGroupChat = currentActiveGrp?.type === "group" && String(currentActiveGrp.id) === String(data.group_id);
          if (isInGroupChat) {
            lastReplacedTempRef.current = null;
            setMessages(prev => {
              let next = prev; const msg = data as Message;
              if (data.user === me) {
                const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
                if (idx !== -1) { lastReplacedTempRef.current = String(prev[idx].id); next = [...prev]; next[idx] = msg; }
                else if (!prev.find(m => String(m.id) === String(msg.id))) next = [...prev, msg];
              } else if (!prev.find(m => String(m.id) === String(msg.id))) next = [...prev, msg];
              messagesCache.current[String(data.group_id)] = next; return next;
            });
            const replacedId = lastReplacedTempRef.current;
            if (replacedId) { const t = pendingTempTimers.current.get(replacedId); if (t) { clearTimeout(t); pendingTempTimers.current.delete(replacedId); } setFailedMsgIds(prev => { const n = new Set(prev); n.delete(replacedId); return n; }); }
            setTimeout(scrollBottom, 50);
          } else if (data.user !== me) {
            setUnread(prev => { const next = { ...prev, [String(data.group_id)]: (prev[String(data.group_id)] || 0) + 1 }; try { localStorage.setItem("cached_unread", JSON.stringify(next)); } catch { } return next; });
            notify(`${data.group_name}`, `${data.sender_name || "Someone"}: ${data.content}`, String(data.group_id));
          }
          break;
        }
        case "reaction": setMessages(prev => prev.map(m => { if (String(m.id) === String(data.message_id)) { if (data.reactions && typeof data.reactions === "object") return { ...m, reactions: data.reactions as Record<string, string[]> }; const current = m.reactions || {}; const users = current[data.emoji as string] || []; if (!users.includes(String(data.user))) return { ...m, reactions: { ...current, [data.emoji as string]: [...users, String(data.user)] } }; } return m; })); break;
        case "read_receipt": setMessages(prev => prev.map(m => { if (m.user === me) { if (data.group_id && m.group_id === data.group_id) { const rb = m.read_by || []; if (!rb.includes(String(data.user))) return { ...m, is_read: true, read_by: [...rb, String(data.user)] }; } else if (!data.group_id && !m.group_id) return { ...m, is_read: true }; } return m; })); break;
        case "message_edited": setMessages(prev => prev.map(m => String(m.id) === String(data.id) ? { ...m, content: String(data.content || ""), edited_at: data.edited_at as string } : m)); break;
        case "message_deleted": setMessages(prev => prev.map(m => String(m.id) === String(data.id) ? { ...m, is_deleted: true } : m)); break;
        case "presence": setContacts(prev => prev.map(c => c.email === data.user ? { ...c, is_online: Boolean(data.online) } : c)); break;
        case "call_offer": {
          iceCandidateQueueRef.current = [];
          const callerEmail = String(data.user || "");
          const callerDisplayName = String(data.sender_name || "").trim() || (() => { const c = contacts.find(c => c.email === callerEmail); return c ? contactLabelFn(c) : ""; })() || "Incoming Call";
          const vid = Boolean(data.isVideo);
          setCallPeer(callerEmail); setCallPeerName(callerDisplayName); setIsVideoCall(vid); isVideoCallRef.current = vid;
          updateCallState("incoming"); callDirectionRef.current = "incoming";
          pendingRemoteDescriptionRef.current = data.sdp as RTCSessionDescriptionInit;
          startRingtone(); notifyCall(vid ? "📹 Incoming Video Call" : "📞 Incoming Voice Call", `${callerDisplayName} is calling…`);
          break;
        }
        case "call_answer": { const pc = pcMapRef.current.get(String(data.user)) || peerConnectionRef.current; if (pc) { await pc.setRemoteDescription(new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit)); updateCallState("connected"); callStartTimeRef.current = Date.now(); while (iceCandidateQueueRef.current.length > 0) { const c = iceCandidateQueueRef.current.shift(); if (c) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error); } } break; }
        case "ice_candidate": { const pc = pcMapRef.current.get(String(data.user)) || peerConnectionRef.current; if (pc && pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(data.candidate as RTCIceCandidateInit)).catch(console.error); else iceCandidateQueueRef.current.push(data.candidate as RTCIceCandidateInit); break; }
        case "call_end": endCall(false); break;
        case "call_reject": endCall(false, "rejected"); break;
      }
    };
  }, [endCall, updateCallState, scrollBottom, updateActivity, notify, notifyCall, startRingtone, apiFetch, contactLabelFn, persistSeenIds, loadContacts, sendReadReceipt]); // eslint-disable-line

  useEffect(() => { initWSRef.current = initWS; }, [initWS]);
  useEffect(() => {
    if (token) { (async () => { await Promise.all([loadProfile(), loadContacts(), loadGroups()]); initWS(); })(); }
    return () => { if (wsPingInterval.current) clearInterval(wsPingInterval.current); if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); } };
  }, [token]); // eslint-disable-line

  const sendMessage = async () => {
    const text = inputMsg.trim(); if (!text || !activeChat) return;
    setInputMsg(""); setShowEmojis(false);
    const { type, id } = activeChat;
    const tempId = `temp-${Date.now()}-${Math.random()}`;
    const optimisticMsg: Message = {
      id: tempId, user: currentUser, content: text, timestamp: new Date().toISOString(),
      ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }),
      ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}),
    };
    setMessages(prev => { const next = [...prev, optimisticMsg]; messagesCache.current[String(id)] = next; return next; });
    updateActivity(id, text); setTimeout(scrollBottom, 50);
    const failTimer = setTimeout(() => { setFailedMsgIds(prev => new Set(prev).add(tempId)); pendingTempTimers.current.delete(tempId); }, 10000);
    pendingTempTimers.current.set(tempId, failTimer);
    wsSend(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", content: text, message_type: "text", ...(type === "user" ? { target_user: id } : { group_id: id }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) }));
    setReplyingTo(null);
  };

  const retryMessage = useCallback((msg: Message) => {
    if (!activeChat) return;
    const tid = String(msg.id);
    setFailedMsgIds(prev => { const n = new Set(prev); n.delete(tid); return n; });
    const existing = pendingTempTimers.current.get(tid);
    if (existing) { clearTimeout(existing); pendingTempTimers.current.delete(tid); }
    const newTempId = `temp-${Date.now()}-${Math.random()}`;
    const newTemp: Message = { ...msg, id: newTempId, timestamp: new Date().toISOString() };
    setMessages(prev => { const next = prev.map(m => String(m.id) === tid ? newTemp : m); messagesCache.current[String(activeChat.id)] = next; return next; });
    const failTimer = setTimeout(() => { setFailedMsgIds(prev => new Set(prev).add(newTempId)); pendingTempTimers.current.delete(newTempId); }, 10000);
    pendingTempTimers.current.set(newTempId, failTimer);
    wsSend(JSON.stringify({ type: activeChat.type === "user" ? "direct_message" : "group_message", content: msg.content, message_type: "text", ...(activeChat.type === "user" ? { target_user: activeChat.id } : { group_id: activeChat.id }) }));
  }, [activeChat, wsSend]);

  const sendReaction = useCallback((msgId: string | number, emoji: string) => {
    if (!activeChat) return; setReactionPickerId(null); setSelectedMsgId(null);
    wsSend(JSON.stringify({ type: "reaction", message_id: msgId, emoji, ...(activeChat.type === "user" ? { target_user: activeChat.id } : { group_id: activeChat.id }) }));
  }, [activeChat, wsSend]);

  const saveEdit = async () => {
    if (!editingId || !activeChat) return;
    try { await apiFetch<void>(`/messages/${editingId}`, { method: "PATCH", body: JSON.stringify({ content: editingText }) }); setMessages(prev => prev.map(m => m.id === editingId ? { ...m, content: editingText, edited_at: new Date().toISOString() } : m)); setEditingId(null); setEditingText(""); } catch { }
  };

  const deleteMsg = async (id: string | number) => {
    if (String(id).startsWith("temp-")) {
      const tid = String(id);
      const t = pendingTempTimers.current.get(tid);
      if (t) { clearTimeout(t); pendingTempTimers.current.delete(tid); }
      setFailedMsgIds(prev => { const n = new Set(prev); n.delete(tid); return n; });
      setMessages(prev => { const next = prev.filter(m => String(m.id) !== tid); messagesCache.current[String(activeChat?.id || "")] = next; return next; });
      return;
    }
    try { await apiFetch<void>(`/messages/${id}`, { method: "DELETE" }); setMessages(prev => prev.map(m => m.id === id ? { ...m, is_deleted: true } : m)); setDeletedMsgIds(prev => { const next = new Set(prev); next.add(String(id)); if (currentUserRef.current) localStorage.setItem(`deleted_msgs_${currentUserRef.current}`, JSON.stringify([...next])); deletedMsgIdsRef.current = next; return next; }); } catch { }
  };

  const sendTypingEvent = useDebounceCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && activeChatRef.current?.type === "user") wsRef.current.send(JSON.stringify({ type: "typing", target_user: activeChatRef.current.id }));
  }, 300);

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => { setInputMsg(e.target.value); sendTypingEvent(); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file || !activeChat) return;
    const form = new FormData(); form.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form });
      if (!res.ok) { alert("Upload failed"); return; }
      const data = await res.json();
      const isImg = data.content_type?.startsWith("image"), isAud = data.content_type?.startsWith("audio"), isVid = data.content_type?.startsWith("video"), isPdf = data.content_type === "application/pdf";
      const tag = isImg ? `[IMAGE]${data.url}` : isAud ? `[AUDIO]${data.url}` : isVid ? `[VIDEO]${data.url}` : isPdf ? `[PDF]${data.url}` : `[FILE]${data.url}`;
      const msgType = isImg ? "image" : isAud ? "audio" : isVid ? "video" : isPdf ? "pdf" : "file";
      const { type, id } = activeChat;
      const optimisticMsg: Message = { id: `temp-${Date.now()}-${Math.random()}`, user: currentUser, content: tag, timestamp: new Date().toISOString(), ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) };
      setMessages(prev => { const next = [...prev, optimisticMsg]; messagesCache.current[String(id)] = next; return next; });
      updateActivity(id, tag); setTimeout(scrollBottom, 50);
      wsRef.current?.send(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", content: tag, message_type: msgType, ...(type === "user" ? { target_user: id } : { group_id: id }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) }));
      setReplyingTo(null);
    } catch { }
    e.target.value = "";
  };

  const getMediaStream = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new Error("Camera/microphone not available.");
    try { return await md.getUserMedia(constraints); }
    catch (err: any) {
      const name: string = err?.name || "";
      if ((name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") && constraints.video && typeof constraints.video === "object") return md.getUserMedia({ audio: constraints.audio, video: true });
      if (name === "NotAllowedError" || name === "PermissionDeniedError") throw new Error("Permission denied. Please allow camera/microphone access.");
      if (name === "NotFoundError" || name === "DevicesNotFoundError") throw new Error("No camera/microphone found.");
      if (name === "NotReadableError" || name === "TrackStartError") throw new Error("Device already in use.");
      throw err;
    }
  };

  const toggleRecording = async () => {
    if (!activeChat) return;
    if (isRecording) { mediaRecorderRef.current?.stop(); setIsRecording(false); mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop()); return; }
    try {
      const stream = await getMediaStream({ audio: true }); audioChunksRef.current = [];
      const mr = new MediaRecorder(stream); mediaRecorderRef.current = mr;
      mr.ondataavailable = e => audioChunksRef.current.push(e.data);
      mr.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" }); const form = new FormData(); form.append("file", blob, "voice.webm");
        const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form });
        const data = await res.json(); const tag = `[AUDIO]${data.url}`;
        const { type, id } = activeChat;
        const optimisticMsg: Message = { id: `temp-${Date.now()}-${Math.random()}`, user: currentUser, content: tag, timestamp: new Date().toISOString(), ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }) };
        setMessages(prev => { const next = [...prev, optimisticMsg]; messagesCache.current[String(id)] = next; return next; });
        setTimeout(scrollBottom, 50);
        wsRef.current?.send(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", content: tag, message_type: "audio", ...(type === "user" ? { target_user: id } : { group_id: id }) }));
      };
      mr.start(); setIsRecording(true);
    } catch (err: any) { alert(`Microphone error: ${err?.message || err}`); setIsRecording(false); }
  };

  const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }, { urls: "turn:a.relay.metered.ca:80", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" }, { urls: "turn:a.relay.metered.ca:80?transport=tcp", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" }, { urls: "turn:a.relay.metered.ca:443", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" }, { urls: "turns:a.relay.metered.ca:443?transport=tcp", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" }], iceCandidatePoolSize: 10 };

  const setupWebRTC = async (targetEmail: string) => {
    const localStream = localStreamRef.current; if (!localStream) throw new Error("Local media stream unavailable");
    const pc = new RTCPeerConnection(rtcConfig); pcMapRef.current.set(targetEmail, pc); peerConnectionRef.current = pc;
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.ontrack = event => {
      const stream = event.streams[0]; remoteStreamRef.current = stream;
      setRemoteStreams(prev => ({ ...prev, [targetEmail]: stream }));
      if (isVideoCallRef.current) { if (remoteVideoRef.current) { remoteVideoRef.current.srcObject = stream; remoteVideoRef.current.play().catch(() => { }); } }
      else { if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = stream; remoteAudioRef.current.play().catch(() => { }); applyAudioOutput(isSpeaker); } if (remoteVideoRef.current) { remoteVideoRef.current.srcObject = stream; remoteVideoRef.current.play().catch(() => { }); } }
    };
    pc.onicecandidate = event => { if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "ice_candidate", target_user: targetEmail, candidate: event.candidate })); };
    pc.oniceconnectionstatechange = () => { const s = pc.iceConnectionState; if (s === "failed") { if (pc.restartIce) { pc.restartIce(); } else { endCall(true, "missed"); } } if (s === "disconnected") { setTimeout(() => { if (pc.iceConnectionState === "disconnected") endCall(true, "missed"); }, 5000); } };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") endCall(true, "missed"); };
    return pc;
  };

  const startCall = async (video = true) => {
    if (!activeChat) return;
    const isGroup = activeChat.type === "group";
    const targetIds = isGroup ? groups.find(g => g.id === activeChat.id)?.members.map(getEmail).filter(m => m !== currentUser) || [] : [String(activeChat.id)];
    if (!targetIds.length) return;
    try {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
      iceCandidateQueueRef.current = []; setIsVideoCall(video); isVideoCallRef.current = video; setIsVideoSwapped(false);
      updateCallState("calling"); setCallPeer(targetIds[0]);
      const c = contacts.find(c => c.email === targetIds[0]); setCallPeerName(c ? contactLabelFn(c) : activeChat.name);
      callDirectionRef.current = "outgoing";
      localStreamRef.current = await getMediaStream({ audio: true, video: video ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false });
      if (localVideoRef.current) { localVideoRef.current.srcObject = localStreamRef.current; localVideoRef.current.play().catch(() => { }); }
      for (const target of targetIds) {
        const pc = await setupWebRTC(target); const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        wsRef.current?.send(JSON.stringify({ type: "call_offer", target_user: target, sdp: offer, isVideo: video, sender_name: profile.displayName || profile.username || currentUser }));
      }
    } catch (err: any) { alert(`Could not start call: ${err.message || err}`); endCall(false); }
  };

  const acceptCall = async () => {
    stopRingtone();
    try {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
      const needVideo = isVideoCallRef.current; setIsVideoSwapped(false);
      localStreamRef.current = await getMediaStream({ audio: true, video: needVideo ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false });
      if (localVideoRef.current) { localVideoRef.current.srcObject = localStreamRef.current; localVideoRef.current.play().catch(() => { }); }
      if (!callPeer || !pendingRemoteDescriptionRef.current) throw new Error("No call offer");
      const pc = await setupWebRTC(callPeer); const ws = wsRef.current;
      if (!pc || ws?.readyState !== WebSocket.OPEN) throw new Error("Not ready");
      await pc.setRemoteDescription(new RTCSessionDescription(pendingRemoteDescriptionRef.current));
      while (iceCandidateQueueRef.current.length > 0) { const c = iceCandidateQueueRef.current.shift(); if (c) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error); }
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "call_answer", target_user: callPeer, sdp: answer }));
      updateCallState("connected"); callStartTimeRef.current = Date.now();
    } catch { rejectCall(); }
  };

  const rejectCall = () => {
    stopRingtone();
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "call_reject", target_user: callPeer }));
    endCall(false, "rejected");
  };

  const toggleMute = () => { if (localStreamRef.current) { localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = isMuted)); setIsMuted(!isMuted); } };
  const toggleSpeaker = () => { const s = !isSpeaker; setIsSpeaker(s); applyAudioOutput(s); };
  const switchCamera = async () => {
    if (!isVideoCall || !localStreamRef.current) return;
    const newMode = facingMode === "user" ? "environment" : "user";
    try {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      let ns: MediaStream | null = null;
      try { ns = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: { exact: newMode } } }); } catch { ns = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); }
      if (!ns) return; localStreamRef.current = ns;
      if (isMuted) ns.getAudioTracks().forEach(t => (t.enabled = false));
      if (localVideoRef.current) { localVideoRef.current.srcObject = ns; localVideoRef.current.play().catch(() => { }); }
      const [at] = ns.getAudioTracks(); const [vt] = ns.getVideoTracks();
      pcMapRef.current.forEach(pc => pc.getSenders().forEach(sender => { if (sender.track?.kind === "audio" && at) sender.replaceTrack(at); if (sender.track?.kind === "video" && vt) sender.replaceTrack(vt); }));
      setFacingMode(newMode);
    } catch (e) { console.error("Camera switch failed:", e); }
  };

  useEffect(() => { let interval: ReturnType<typeof setInterval>; if (callState === "connected") { interval = setInterval(() => setCallDuration(Math.floor((Date.now() - (callStartTimeRef.current || Date.now())) / 1000)), 1000); } else { setCallDuration(0); } return () => clearInterval(interval); }, [callState]);
  useEffect(() => {
    if (callState === "idle") return;
    const attach = () => {
      if (localStreamRef.current && localVideoRef.current && localVideoRef.current.srcObject !== localStreamRef.current) { localVideoRef.current.srcObject = localStreamRef.current; localVideoRef.current.play().catch(() => { }); }
      if (remoteStreamRef.current && remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current) { remoteVideoRef.current.srcObject = remoteStreamRef.current; remoteVideoRef.current.play().catch(() => { }); }
      if (!isVideoCallRef.current && remoteAudioRef.current && remoteStreamRef.current && remoteAudioRef.current.srcObject !== remoteStreamRef.current) { remoteAudioRef.current.srcObject = remoteStreamRef.current; remoteAudioRef.current.play().catch(() => { }); applyAudioOutput(isSpeaker); }
    };
    attach(); const t1 = setTimeout(attach, 200); const t2 = setTimeout(attach, 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [callState, isVideoCall, remoteStreams, isSpeaker, applyAudioOutput]);

  const onPipMouseDown = (e: React.MouseEvent) => { pipDragging.current = true; pipDragStart.current = { mx: e.clientX, my: e.clientY, x: pipPos.x, y: pipPos.y }; e.preventDefault(); };
  const onPipTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; pipDragging.current = true; pipDragStart.current = { mx: t.clientX, my: t.clientY, x: pipPos.x, y: pipPos.y }; };
  const onPipMouseMove = useCallback((e: MouseEvent) => { if (!pipDragging.current) return; setPipPos({ x: pipDragStart.current.x + e.clientX - pipDragStart.current.mx, y: pipDragStart.current.y + e.clientY - pipDragStart.current.my }); }, []);
  const onPipTouchMove = useCallback((e: TouchEvent) => { if (!pipDragging.current) return; const t = e.touches[0]; setPipPos({ x: pipDragStart.current.x + t.clientX - pipDragStart.current.mx, y: pipDragStart.current.y + t.clientY - pipDragStart.current.my }); }, []);
  const onPipDragEnd = useCallback(() => { pipDragging.current = false; }, []);
  useEffect(() => { if (callState !== "idle" && isVideoCall) { window.addEventListener("mousemove", onPipMouseMove); window.addEventListener("mouseup", onPipDragEnd); window.addEventListener("touchmove", onPipTouchMove, { passive: true }); window.addEventListener("touchend", onPipDragEnd); return () => { window.removeEventListener("mousemove", onPipMouseMove); window.removeEventListener("mouseup", onPipDragEnd); window.removeEventListener("touchmove", onPipTouchMove); window.removeEventListener("touchend", onPipDragEnd); }; } }, [callState, isVideoCall, onPipMouseMove, onPipTouchMove, onPipDragEnd]);

  const isTyping = useMemo(() => activeChat?.type === "user" && typingSet.has(String(activeChat.id)), [activeChat, typingSet]);
  const sortedContacts = useMemo(() => { const q = searchQuery.toLowerCase(); const list = q ? contacts.filter(c => contactLabel(c).toLowerCase().includes(q) || (c.username || "").toLowerCase().includes(q)) : [...contacts]; return list.sort((a, b) => (lastActivity[b.email] || 0) - (lastActivity[a.email] || 0)); }, [contacts, searchQuery, lastActivity, contactLabel]);
  const sortedGroups = useMemo(() => { const q = searchQuery.toLowerCase(); const list = q ? groups.filter(g => g.name.toLowerCase().includes(q)) : [...groups]; return list.sort((a, b) => (lastActivity[String(b.id)] || 0) - (lastActivity[String(a.id)] || 0)); }, [groups, searchQuery, lastActivity]);
  const searchMessageResults = useMemo(() => {
    if (!searchQuery) return [];
    const results: (Message & { chatId: string | number; chatType: "user" | "group" })[] = [];
    Object.entries(messagesCache.current).forEach(([chatId, msgs]) => { const isGroup = groups.some(g => String(g.id) === chatId); msgs.forEach(m => { if (!m._callRecord && m.content.toLowerCase().includes(searchQuery.toLowerCase()) && !m.content.startsWith("[")) results.push({ ...m, chatId, chatType: isGroup ? "group" : "user" }); }); });
    return results;
  }, [searchQuery, groups]);

  const formatDate = (ts: string) => { const d = parseTs(ts); const today = new Date(); if (d.toDateString() === today.toDateString()) return "Today"; const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); if (d.toDateString() === yesterday.toDateString()) return "Yesterday"; return d.toLocaleDateString([], { month: "short", day: "numeric" }); };
  const groupedMessages = useMemo(() => { const out: GroupedMessage[] = []; let lastDate: string | null = null; for (const msg of messages) { const label = formatDate(msg.timestamp); if (label !== lastDate) { out.push({ type: "divider", label }); lastDate = label; } out.push({ type: "msg", ...msg }); } return out; }, [messages]); // eslint-disable-line

  const handleAppClick = useCallback(() => { setSidebarDeleteId(null); setReactionPickerId(null); setSelectedMsgId(null); }, []);
  const checkUsernameAvailability = useDebounceCallback(async (value: string) => { if (value.length >= 3) { try { const res = await apiFetch<{ available: boolean }>(`/auth/check-username/${value}`); if (!res.available) dispatchAuth({ type: "SET_ERROR", value: "Username already taken" }); } catch { } } }, 500);

  const emojis = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "🥲", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🫢", "🤫", "🤔", "🫡", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😕", "😟", "🙁", "☹️", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥", "😢", "😭", "😱", "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "💀", "👻", "😈", "👿", "💩", "🤡", "👹", "👍", "👎", "👌", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "✋", "🤚", "🖐️", "👋", "🤏", "👏", "🙌", "🫶", "🤲", "🙏", "✍️", "💪", "❤️", "🧡", "💛", "💚", "💙", "💜", "🔥", "💫", "⭐", "🌟", "✨", "💥", "❄️", "🌈", "☀️", "🌙", "🎉", "🎊", "🎈", "🎁", "🏆", "🥇", "🎵", "🎶", "🎤", "🎸", "🎹", "🚀", "✈️", "🌍", "🌊", "🌺", "🌸", "🍕", "🍔", "☕", "✅", "❌", "⚡", "💯", "💬", "📌", "🔗", "🔑", "💡", "🔔", "📢", "👀", "💤", "🆗", "🆙", "🔝"];
  const reactionEmojis = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "💯"];
  const callDisplayName = callPeerName || (callPeer ? getPeerName(callPeer) : "");

  if (!isMounted) return (<div className="app loading-screen"><div className="spinner loading-spinner-circle"></div></div>);

  return (
    <div className="app" onClick={handleAppClick}>

      {showContactProfile && activeChat?.type === "user" && (
        <ContactProfile
          contact={contacts.find(c => c.email === activeChat.id)}
          activeChat={activeChat} currentUser={currentUser} nicknames={nicknames}
          contactLabel={contactLabel} callLogs={callLogs} messagesCache={messagesCache.current}
          onClose={() => setShowContactProfile(false)}
          onCall={(video) => { setShowContactProfile(false); startCall(video); }}
          onNicknameEdit={() => { setShowContactProfile(false); openHeaderNicknameEdit(); }}
          getPeerName={getPeerName} onViewFile={(url, type) => setViewFile({ url, type })}
        />
      )}

      {showGroupProfile && activeChat?.type === "group" && (
        <GroupProfile
          group={groups.find(g => g.id === activeChat.id)} activeChat={activeChat}
          currentUser={currentUser} contacts={contacts} contactLabel={contactLabel}
          callLogs={callLogs} messagesCache={messagesCache.current}
          newGroupMemberEmail={newGroupMemberEmail} setNewGroupMemberEmail={setNewGroupMemberEmail}
          isUploadingGroupAvatar={isUploadingGroupAvatar} groupAvatarInputRef={groupAvatarInputRef}
          handleGroupAvatarUpload={handleGroupAvatarUpload}
          onClose={() => setShowGroupProfile(false)}
          onCall={(video) => { setShowGroupProfile(false); startCall(video); }}
          onAddMember={addGroupMember} onViewFile={(url, type) => setViewFile({ url, type })}
          getPeerName={getPeerName}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          AUTH SCREENS  (no Google button — pure email/password only)
      ══════════════════════════════════════════════════════════════════════ */}
      {!isAuth ? (
        <div className="auth-screen">
          <div className="auth-glow auth-glow-1"></div>
          <div className="auth-glow auth-glow-2"></div>

          {/* ── LEFT PANEL ── */}
          <div className="auth-left">
            <div className="brand">
              <div className="brand-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
              </div>
              <span>Pulse</span>
            </div>
            <div className="auth-hero">
              <h1>Connect.<br />Fast.<br /><em>Alive.</em></h1>
              <p>Keep your conversations flowing with real-time speed and end-to-end clarity.</p>
            </div>
            <div className="auth-pills">
              <span className="a-pill a-pill--primary">⚡ Real-time</span>
              <span className="a-pill">💬 Encrypted</span>
              <span className="a-pill">📹 Video calls</span>
            </div>
          </div>

          {/* ── RIGHT PANEL ── */}
          <div className="auth-right">
            <div className="auth-card">

              {/* ── CHECK EMAIL (verify / reset link sent) ── */}
              {auth.step === "verify-email" && (<>
                <div style={{ fontSize: 40, textAlign: "center", marginBottom: 12 }}>📬</div>
                <h2 className="ac-title">Check your inbox</h2>
                <p className="ac-sub">We sent a link to <strong>{auth.email}</strong>.<br />Click it, then come back and sign in.</p>
                <button className="ac-btn" onClick={() => dispatchAuth({ type: "SET_STEP", step: "signin" })}>Back to sign in</button>
              </>)}

              {/* ── SIGN IN ── */}
              {auth.step === "signin" && (<>
                <h2 className="ac-title">Welcome back</h2>
                <p className="ac-sub">Sign in to your Pulse account</p>

                <div className="ac-field">
                  <label>Email</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></svg>
                    <input value={auth.email} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "email", value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleSignIn()} type="email" placeholder="you@example.com" className="ac-input" />
                  </div>
                </div>

                <div className="ac-field">
                  <label>Password</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <input value={auth.pass} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "pass", value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleSignIn()} type="password" placeholder="••••••••" className="ac-input" />
                  </div>
                </div>

                <button disabled={auth.loading} onClick={handleSignIn} className="ac-btn">
                  {auth.loading && <span className="spinner"></span>}
                  {auth.loading ? "Signing in…" : "Sign in"}
                  {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                </button>

                {/* Forgot password link */}
                <p style={{ textAlign: "center", marginTop: 10 }}>
                  <button
                    onClick={() => dispatchAuth({ type: "SET_STEP", step: "forgot-password" })}
                    style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
                  >
                    Forgot password?
                  </button>
                </p>

                <p className="ac-sub" style={{ marginTop: 6, textAlign: "center" }}>
                  No account?{" "}
                  <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "signup" })} style={{ background: "none", border: "none", color: "var(--green)", cursor: "pointer", fontWeight: 600 }}>
                    Create one
                  </button>
                </p>
              </>)}

              {/* ── SIGN UP ── */}
              {auth.step === "signup" && (<>
                <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "signin" })} className="ac-back">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg> Back
                </button>
                <h2 className="ac-title">Create account</h2>
                <p className="ac-sub">Join Pulse — it takes 30 seconds</p>

                <div className="ac-field">
                  <label>Email</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></svg>
                    <input value={auth.email} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "email", value: e.target.value })} type="email" placeholder="you@example.com" className="ac-input" />
                  </div>
                </div>
                <div className="ac-field">
                  <label>Password</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <input value={auth.pass} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "pass", value: e.target.value })} type="password" placeholder="At least 6 characters" className="ac-input" />
                  </div>
                </div>
                <div className="ac-field">
                  <label>Confirm password</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <input value={auth.pass2} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "pass2", value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleSignUp()} type="password" placeholder="••••••••" className="ac-input" />
                  </div>
                </div>
                <button disabled={auth.loading} onClick={handleSignUp} className="ac-btn">
                  {auth.loading && <span className="spinner"></span>}
                  {auth.loading ? "Creating account…" : "Continue"}
                  {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                </button>
              </>)}

              {/* ── PICK USERNAME ── */}
              {auth.step === "pick-username" && (<>
                <div style={{ fontSize: 36, textAlign: "center", marginBottom: 8 }}>🏷️</div>
                <h2 className="ac-title">Pick a username</h2>
                <p className="ac-sub">Your unique handle. Lowercase letters, numbers, underscores (3–30 chars).</p>
                <div className="ac-field">
                  <label>Username</label>
                  <div className="ac-input-wrap">
                    <span className="ac-icon" style={{ fontWeight: 700, color: "var(--text-3)", fontSize: 14 }}>@</span>
                    <input value={auth.user} onChange={e => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""); dispatchAuth({ type: "SET_FIELD", field: "user", value: v }); dispatchAuth({ type: "SET_ERROR", value: "" }); checkUsernameAvailability(v); }} onKeyDown={e => e.key === "Enter" && handleRegister()} type="text" placeholder="e.g. john_doe" className="ac-input" maxLength={30} />
                  </div>
                  {auth.user.length >= 3 && !auth.error && <p style={{ fontSize: 12, color: "var(--success)", marginTop: 4 }}>✓ Available</p>}
                </div>
                <button disabled={auth.loading || !!auth.error || auth.user.length < 3} onClick={handleRegister} className="ac-btn">
                  {auth.loading && <span className="spinner"></span>}
                  {auth.loading ? "Setting up…" : "Finish setup"}
                  {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                </button>
              </>)}

              {/* ── FORGOT PASSWORD ── */}
              {auth.step === "forgot-password" && (<>
                <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "signin" })} className="ac-back">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg> Back
                </button>
                <div style={{ fontSize: 36, textAlign: "center", marginBottom: 8 }}>🔑</div>
                <h2 className="ac-title">Reset password</h2>
                <p className="ac-sub">Enter your email and we'll send you a reset link.</p>
                <div className="ac-field">
                  <label>Email</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></svg>
                    <input value={auth.email} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "email", value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleForgotPassword()} type="email" placeholder="you@example.com" className="ac-input" />
                  </div>
                </div>
                <button disabled={auth.loading} onClick={handleForgotPassword} className="ac-btn">
                  {auth.loading && <span className="spinner"></span>}
                  {auth.loading ? "Sending…" : "Send reset link"}
                  {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                </button>
              </>)}

              {/* ── RESET PASSWORD (after clicking the email link) ── */}
              {auth.step === "reset-password" && (<>
                <div style={{ fontSize: 36, textAlign: "center", marginBottom: 8 }}>🔒</div>
                <h2 className="ac-title">Set new password</h2>
                <p className="ac-sub">Choose a strong new password for your account.</p>
                <div className="ac-field">
                  <label>New password</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <input value={auth.pass} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "pass", value: e.target.value })} type="password" placeholder="At least 6 characters" className="ac-input" />
                  </div>
                </div>
                <div className="ac-field">
                  <label>Confirm new password</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <input value={auth.pass2} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "pass2", value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleResetPassword()} type="password" placeholder="••••••••" className="ac-input" />
                  </div>
                </div>
                <button disabled={auth.loading} onClick={handleResetPassword} className="ac-btn">
                  {auth.loading && <span className="spinner"></span>}
                  {auth.loading ? "Updating…" : "Set new password"}
                  {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                </button>
              </>)}

              {/* ── ERROR BANNER ── */}
              {auth.error && (
                <div className="ac-error">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                  {auth.error}
                </div>
              )}
            </div>
          </div>
        </div>

      ) : (
        /* ══════════════════════════════════════════════════════════════════════
           MAIN APP SHELL
        ══════════════════════════════════════════════════════════════════════ */
        <div className={`shell ${activeChat ? "chat-active" : ""}`}>

          {/* ── SIDEBAR ── */}
          <aside className="sidebar">
            <div className="sb-brand-header">
              <div className="sb-brand-left">
                <div className="sb-brand-icon-wrap"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg></div>
                <span className="sb-brand-name">Pulse</span>
                <span className="sb-ws-dot" style={{ background: wsStatus === "connected" ? "#4ade80" : wsStatus === "reconnecting" ? "#fbbf24" : "#333" }} title={wsStatus} />
                {totalUnread > 0 && <span onClick={e => { e.stopPropagation(); markAllRead(); }} title="Mark all read" className="sb-total-unread">{totalUnread > 99 ? "99+" : totalUnread}</span>}
              </div>
              <div className="sb-brand-actions">
                <button className="sb-icon-btn" title="Call History" onClick={e => { e.stopPropagation(); setShowCallLogUI(true); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                </button>
                <button className={`sb-icon-btn ${showMyProfileSettings ? "sb-icon-btn--active" : ""}`} title="Settings" onClick={e => { e.stopPropagation(); setShowMyProfileSettings(v => !v); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>
                </button>
              </div>
            </div>

            <div className="sb-identity" onClick={e => { e.stopPropagation(); if (profile.avatarUrl) setViewFile({ url: profile.avatarUrl, type: "avatar-circle" }); }}>
              <div className="sb-id-avatar">
                {profile.avatarUrl ? <img src={profile.avatarUrl} alt="Avatar" className="img-cover rounded-sq" /> : (profile.displayName || currentUser)?.[0]?.toUpperCase() || "?"}
              </div>
              <div className="sb-id-info">
                <span className="sb-id-name">{profile.displayName || profile.username || "Me"}</span>
                <span className="sb-id-status">@{profile.username}{wsStatus === "reconnecting" && <span style={{ color: "#fbbf24", fontSize: 9 }}> · Reconnecting…</span>}</span>
              </div>
            </div>

            {showMyProfileSettings && (
              <div className="my-profile-settings-panel" onClick={e => e.stopPropagation()}>
                <button onClick={logout} className="settings-action-row settings-action-row--danger">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>Sign Out
                </button>
                <button className="settings-action-row" onClick={() => setShowProfile(!showProfile)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>Edit Profile
                  <svg className={`chevron ${showProfile ? "chevron--up" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: "auto" }}><polyline points="6,9 12,15 18,9" /></svg>
                </button>
                {showProfile && (
                  <div className="sb-profile-form drop">
                    <input type="file" ref={avatarInputRef} accept="image/*" className="hidden-input" onChange={handleAvatarUpload} />
                    <div className="avatar-edit-section">
                      <div className="avatar-edit-row">
                        <div className="avatar-edit-box">{profile.avatarUrl ? <img src={profile.avatarUrl} alt="Avatar" className="img-cover" /> : (profile.displayName || currentUser)?.[0]?.toUpperCase() || "?"}</div>
                        <button onClick={() => avatarInputRef.current?.click()} className="avatar-upload-btn" disabled={isUploadingAvatar}>{isUploadingAvatar ? "Uploading…" : "📷 Change photo"}</button>
                      </div>
                    </div>
                    <input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} placeholder="Display name…" className="sb-field" />
                    <div style={{ position: "relative" }}><span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)", fontWeight: 700, fontSize: 13 }}>@</span><input value={editUsername} onChange={e => setEditUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} placeholder="username" className="sb-field" style={{ paddingLeft: 22 }} /></div>
                    <p className="text-muted-sm text-muted-sm-margin">Username is how others find you.</p>
                    <button onClick={saveProfile} className="sb-save-btn">Save Profile</button>
                  </div>
                )}
              </div>
            )}

            <div className="sb-divider"></div>

            <div className="sb-search-container">
              <div className="sb-search-wrap">
                <svg className="sb-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search conversations…" className="sb-search-input" />
                {searchQuery && <button onClick={() => setSearchQuery("")} className="sb-search-clear">✕</button>}
              </div>
              {totalUnread > 0 && <button onClick={e => { e.stopPropagation(); markAllRead(); }} className="sb-mark-read-btn">✓ All</button>}
            </div>

            {searchQuery && searchMessageResults.length > 0 && (
              <div className="sb-section search-results-section">
                <div className="sb-section-hdr"><div className="sb-section-label-group"><span className="sb-section-label-text">Messages</span></div></div>
                <div className="sb-list">
                  {searchMessageResults.map(m => {
                    const groupName = groups.find(g => String(g.id) === String(m.chatId))?.name;
                    const c = contacts.find(c => c.email === String(m.chatId));
                    const chatName = m.chatType === "group" ? groupName : (c ? contactLabel(c) : "Unknown User");
                    return (
                      <button key={`${m.chatId}-${m.id}`} className="sb-item" onClick={() => openChat({ type: m.chatType, id: String(m.chatId), name: String(chatName || "Chat") })}>
                        <div className="sb-item-body mw-0"><span className="sb-item-name name-row">{String(chatName || "Chat")}</span><span className="sb-item-status text-truncate">{m.content}</span></div>
                      </button>
                    );
                  })}
                </div>
                <div className="sb-divider"></div>
              </div>
            )}

            <div className="sb-section">
              <div className="sb-section-hdr">
                <div className="sb-section-label-group">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                  <span className="sb-section-label-text">Messages</span>
                  <button onClick={() => setShowNewContact(!showNewContact)} className={`sb-add-btn-inline ${showNewContact ? "active" : ""}`} title="New chat">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  </button>
                </div>
              </div>
              {showNewContact && (
                <div className="sb-add-form drop">
                  <div style={{ position: "relative" }}><span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)", fontWeight: 700, fontSize: 13 }}>@</span><input value={newContactUsername} onChange={e => setNewContactUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} onKeyDown={e => { if (e.key === "Enter") { addContactByUsername(newContactUsername); setNewContactUsername(""); setShowNewContact(false); } }} placeholder="username" className="sb-field" style={{ paddingLeft: 22 }} autoFocus /></div>
                  <p className="text-muted-sm">Search by @username</p>
                  <button onClick={() => { addContactByUsername(newContactUsername); setNewContactUsername(""); setShowNewContact(false); }} className="sb-go-btn">Start chat</button>
                </div>
              )}
              <div className="sb-list">
                {sortedContacts.map(c => (
                  <ContactItem key={c.email} contact={c} isActive={activeChat?.id === c.email} isDeleteTarget={sidebarDeleteId === c.email} unreadCount={unread[c.email] || 0} lastPreview={lastPreview[c.email] || ""} label={contactLabel(c)} nickname={nicknames[c.email]} lastActivityTs={lastActivity[c.email] || 0} onOpen={() => openChat({ type: "user", id: c.email, name: contactLabel(c) })} onDelete={() => deleteChat("user", c.email)} onDeleteTarget={setSidebarDeleteId} onClearDelete={() => setSidebarDeleteId(null)} />
                ))}
              </div>
            </div>

            <div className="sb-divider"></div>

            <div className="sb-section">
              <div className="sb-section-hdr">
                <div className="sb-section-label-group">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>
                  <span className="sb-section-label-text">Groups</span>
                  <button onClick={() => setShowNewGroup(!showNewGroup)} className={`sb-add-btn-inline ${showNewGroup ? "active" : ""}`} title="New group">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  </button>
                </div>
              </div>
              {showNewGroup && (
                <div className="sb-add-form drop">
                  <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Group name *" className="sb-field" />
                  <input value={newGroupMembers} onChange={e => setNewGroupMembers(e.target.value)} placeholder="Member emails (comma-separated) *" className="sb-field" />
                  <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} placeholder="Description (optional)" className="sb-field" />
                  <button onClick={() => { const members = newGroupMembers.trim().split(",").map(s => s.trim()).filter(Boolean); if (!newGroupName.trim() || !members.length) return; apiFetch("/groups", { method: "POST", body: JSON.stringify({ name: newGroupName.trim(), description: newGroupDesc, members }) }).then(() => { setNewGroupName(""); setNewGroupDesc(""); setNewGroupMembers(""); setShowNewGroup(false); loadGroups(); }); }} className="sb-go-btn secondary">Create group</button>
                </div>
              )}
              <div className="sb-list">
                {sortedGroups.map(g => (
                  <GroupItem key={g.id} group={g} isActive={activeChat?.id === g.id} isDeleteTarget={sidebarDeleteId === String(g.id)} unreadCount={unread[String(g.id)] || 0} lastPreview={lastPreview[String(g.id)] || ""} lastActivityTs={lastActivity[String(g.id)] || 0} onOpen={() => openChat({ type: "group", id: g.id, name: g.name })} onDelete={() => deleteChat("group", g.id)} onDeleteTarget={setSidebarDeleteId} onClearDelete={() => setSidebarDeleteId(null)} />
                ))}
              </div>
            </div>
          </aside>

          {/* ── CHAT MAIN ── */}
          <main className="chat">
            {!activeChat ? (
              <div className="empty-state">
                <div className="empty-rings">
                  <div className="ring r1"></div><div className="ring r2"></div><div className="ring r3"></div>
                  <svg className="z-1-relative" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                </div>
                <h3>No conversation open</h3>
                <p>Select a contact or group to start messaging</p>
              </div>
            ) : (
              <>
                <header className="chat-hdr">
                  <div className="chat-hdr-left">
                    <button className="mobile-back-btn" onClick={() => setActiveChat(null)}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                    </button>
                    <div
                      className={`hdr-av ${activeChat.type === "group" ? "hdr-av--group" : ""} cursor-pointer pointer-relative`}
                      onClick={() => activeChat.type === "user" ? setShowContactProfile(true) : setShowGroupProfile(true)}
                    >
                      {activeChat.type === "user" && contacts.find(c => c.email === activeChat.id)?.avatar_url
                        ? <img src={contacts.find(c => c.email === activeChat.id)!.avatar_url!} alt="avatar" className="img-cover rounded-circle" />
                        : activeChat.type === "group" && groups.find(g => g.id === activeChat.id)?.avatar_url
                          ? <img src={groups.find(g => g.id === activeChat.id)!.avatar_url!} alt="group" className="img-cover rounded-circle" />
                          : activeChat.name?.[0]?.toUpperCase() || "?"}
                      <div className="hdr-av-overlay">view</div>
                    </div>
                    <div className="hdr-info">
                      <div className="name-row-inline">
                        <span className="hdr-name">
                          {activeChat.type === "user" ? (() => { const c = contacts.find(c => c.email === activeChat.id); return c ? contactLabel(c) : activeChat.name; })() : activeChat.name}
                        </span>
                        {activeChat.type === "user" && (
                          <button onClick={openHeaderNicknameEdit} className={`btn-pencil-nickname ${showHeaderNicknameEdit ? "active" : ""}`}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                          </button>
                        )}
                      </div>
                      {activeChat.type === "user" && (() => { const c = contacts.find(c => c.email === activeChat.id); return c?.username ? <span className="hdr-meta hdr-meta-nickname">@{c.username}</span> : null; })()}
                      <span className="hdr-meta">
                        {activeChat.type === "user" ? (
                          <><span className={`hdr-dot ${contacts.find(c => c.email === activeChat.id)?.is_online ? "hdr-dot--on" : ""}`}></span>{contacts.find(c => c.email === activeChat.id)?.is_online ? "Online" : "Offline"}</>
                        ) : <>{groups.find(g => g.id === activeChat.id)?.members.length || "?"} members</>}
                      </span>
                    </div>
                  </div>
                  <div className="hdr-right">
                    <button onClick={() => startCall(false)} className="tool-btn" title="Voice Call">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                    </button>
                    <button onClick={() => startCall(true)} className="tool-btn" title="Video Call">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                    </button>
                    <button className="tool-btn" title="Delete chat" onClick={() => { if (window.confirm("Delete this chat? Only you will lose it.")) deleteChat(activeChat.type, activeChat.id); }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>
                    </button>
                  </div>
                </header>

                {showHeaderNicknameEdit && activeChat.type === "user" && (
                  <div className="nickname-edit-panel">
                    <span className="nickname-edit-label">🏷 Nickname:</span>
                    <input value={headerNicknameValue} onChange={e => setHeaderNicknameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveContactNickname(String(activeChat.id), headerNicknameValue); if (e.key === "Escape") setShowHeaderNicknameEdit(false); }}
                      placeholder={(() => { const c = contacts.find(c => c.email === activeChat.id); return `Nickname for ${c?.display_name || (c?.username ? `@${c.username}` : activeChat.name)}`; })()}
                      className="sb-field nickname-edit-input" autoFocus />
                    <div className="nickname-edit-actions">
                      <button onClick={() => saveContactNickname(String(activeChat.id), headerNicknameValue)} className="sb-go-btn btn-save-sm">Save</button>
                      {nicknames[String(activeChat.id)] && <button onClick={() => saveContactNickname(String(activeChat.id), "")} className="sb-go-btn btn-clear-sm">Clear</button>}
                      <button onClick={() => setShowHeaderNicknameEdit(false)} className="sb-go-btn btn-close-sm">✕</button>
                    </div>
                  </div>
                )}

                <div ref={msgListRef} className="msg-list" onClick={handleAppClick}>
                  <div ref={loadMoreSentinelRef} style={{ height: 1, marginBottom: 0 }}>
                    {loadingMore && (
                      <div className="load-more-row">
                        <span className="spinner" style={{ width: 14, height: 14 }} />
                        <span style={{ fontSize: 12, color: "var(--text-3)", marginLeft: 6 }}>Loading older messages…</span>
                      </div>
                    )}
                  </div>

                  {groupedMessages.map((item, idx) =>
                    item.type === "divider" ? (
                      <div key={`div-${item.label}-${idx}`} className="date-sep"><span>{item.label}</span></div>
                    ) : (
                      <MessageBubble
                        key={item.id} item={item} currentUser={currentUser}
                        isSelected={selectedMsgId === item.id} isEditing={editingId === item.id}
                        editingText={editingText} reactionPickerId={reactionPickerId}
                        chatType={activeChat.type} reactionEmojis={reactionEmojis}
                        contacts={contacts} getPeerName={getPeerName} contactLabel={contactLabel}
                        isFailed={failedMsgIds.has(String(item.id))}
                        onReply={msg => { setReplyingTo(msg); setReactionPickerId(null); setSelectedMsgId(null); }}
                        onEditStart={(id, text) => { setEditingId(id); setEditingText(text); setReactionPickerId(null); setSelectedMsgId(null); }}
                        onEditSave={saveEdit} onEditCancel={() => setEditingId(null)} onEditChange={setEditingText}
                        onDelete={id => { deleteMsg(id); setSelectedMsgId(null); }}
                        onReaction={sendReaction} onSetReactionPicker={setReactionPickerId}
                        onViewFile={(url, type) => setViewFile({ url, type })} onSelectMsg={setSelectedMsgId}
                        onRetry={retryMessage}
                      />
                    )
                  )}
                </div>

                <div className="typing-area">
                  {isTyping && (
                    <div className="typing-pill">
                      <span className="td"></span><span className="td"></span><span className="td"></span>
                      <span>{(() => { const c = contacts.find(c => c.email === String(activeChat.id)); return c ? contactLabel(c) : activeChat.name; })()} is typing…</span>
                    </div>
                  )}
                </div>

                {replyingTo && (
                  <div className="reply-banner">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--green)", marginBottom: 2 }}>
                        ↩ Replying to {replyingTo.user === currentUser ? "yourself" : (replyingTo.sender_name || getPeerName(replyingTo.user))}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {replyingTo.content.startsWith("[") ? "📎 Attachment" : replyingTo.content}
                      </div>
                    </div>
                    <button onClick={() => setReplyingTo(null)} style={{ marginLeft: 8, padding: "4px 8px", border: "none", background: "none", cursor: "pointer", fontSize: 16, color: "var(--text-3)" }}>✕</button>
                  </div>
                )}

                {showEmojis && (
                  <div className="emoji-picker pop" onClick={e => e.stopPropagation()}>
                    {emojis.map(e => (
                      <button key={e} onClick={() => setInputMsg(prev => prev + e)} style={{ fontSize: 20, background: "none", border: "none", cursor: "pointer", padding: "4px", borderRadius: 4 }}>{e}</button>
                    ))}
                  </div>
                )}

                <div className="input-bar">
                  <input type="file" ref={fileInputRef} onChange={handleFile} accept="image/*,audio/*,video/mp4,.pdf" className="hidden-input" />
                  <input type="file" ref={cameraInputRef} onChange={handleFile} accept="image/*" capture="environment" className="hidden-input" />
                  <button onClick={e => { e.stopPropagation(); setShowEmojis(v => !v); }} className={`tool-btn ${showEmojis ? "tool-btn--on" : ""}`}>😀</button>
                  <button onClick={() => cameraInputRef.current?.click()} className="tool-btn" title="Take photo">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" /></svg>
                  </button>
                  <button onClick={() => fileInputRef.current?.click()} className="tool-btn" title="Attach file">📎</button>
                  <button onClick={toggleRecording} className={`tool-btn ${isRecording ? "tool-btn--rec" : ""}`} title="Voice message">🎤{isRecording && <span className="rec-dot"></span>}</button>
                  <input value={inputMsg} onChange={handleTyping} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()} placeholder={isRecording ? "Recording…" : "Type a message…"} className="msg-input" disabled={isRecording} />
                  <button onClick={sendMessage} disabled={isRecording || !inputMsg.trim()} className="send-btn">➤</button>
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {/* ── CALL LOG ── */}
      {showCallLogUI && (
        <div className="file-viewer-overlay" onClick={() => setShowCallLogUI(false)}>
          <div className="viewer-content cl-modal" onClick={e => e.stopPropagation()}>
            <div className="cl-header">
              <h2 className="cl-title">Call History</h2>
              <button className="cl-close" onClick={() => setShowCallLogUI(false)}>✕</button>
            </div>
            {callLogs.length === 0 ? <p className="cl-empty">No recent calls</p> : (
              <div className="cl-list">
                {callLogs.map(log => (
                  <div key={log.id} className="cl-item">
                    <div>
                      <strong className={`cl-item-name ${log.status !== "completed" ? "missed" : ""}`}>{log.peerName || getPeerName(log.peer)}</strong>
                      <span className="cl-item-meta">
                        <span>{log.direction === "incoming" ? "↙ Incoming" : "↗ Outgoing"}</span>
                        <span>•</span>
                        <span>{log.media === "video" ? "📹 Video" : "📞 Audio"}</span>
                        <span>•</span>
                        <span>{parseTs(log.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      </span>
                    </div>
                    <div className="cl-item-dur">{log.status === "completed" ? fmtDuration(log.duration) : <span className="cl-item-dur status">{log.status}</span>}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CALL OVERLAY ── */}
      {callState !== "idle" && (
        <div className="call-overlay">
          <div className={`call-modal ${isVideoCall && callState === "connected" ? "video-active" : ""}`}
            style={isVideoCall && (callState === "connected" || callState === "calling") ? { position: "fixed", inset: 0, width: "100vw", height: "100vh", maxWidth: "none", borderRadius: 0, margin: 0, padding: 0, background: "#000", display: "flex", flexDirection: "column" } : {}}>

            <div className={`video-container ${isVideoCall && (callState === "connected" || callState === "calling") ? "d-block" : "d-none"}`}
              style={{ position: "relative", flex: 1, background: "#000", overflow: "hidden" }}>
              {isVideoSwapped ? (
                <video autoPlay playsInline muted ref={node => { (localVideoRef as any).current = node; if (node && localStreamRef.current && node.srcObject !== localStreamRef.current) { node.srcObject = localStreamRef.current; node.play().catch(() => { }); } }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#000", zIndex: 1 }} />
              ) : (
                Object.keys(remoteStreams).length > 0
                  ? Object.entries(remoteStreams).map(([peerId, stream]) => (
                    <video key={peerId} autoPlay playsInline ref={node => { if (node && node.srcObject !== stream) { node.srcObject = stream; node.play().catch(() => { }); } }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#000", zIndex: 1 }} />
                  ))
                  : <video autoPlay playsInline ref={node => { (remoteVideoRef as any).current = node; if (node && remoteStreamRef.current && node.srcObject !== remoteStreamRef.current) { node.srcObject = remoteStreamRef.current; node.play().catch(() => { }); } }} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#000", zIndex: 1 }} />
              )}

              <div className="local-video-pip" style={{ left: pipPos.x, top: pipPos.y, cursor: "pointer", zIndex: 10 }} onMouseDown={onPipMouseDown} onTouchStart={onPipTouchStart} onClick={() => { if (!pipDragging.current) setIsVideoSwapped(v => !v); }} title="Tap to swap">
                {isVideoSwapped ? (
                  Object.keys(remoteStreams).length > 0
                    ? Object.entries(remoteStreams).map(([peerId, stream]) => (
                      <video key={peerId} autoPlay playsInline ref={node => { if (node && node.srcObject !== stream) { node.srcObject = stream; node.play().catch(() => { }); } }} />
                    ))
                    : <video autoPlay playsInline ref={node => { (remoteVideoRef as any).current = node; if (node && remoteStreamRef.current && node.srcObject !== remoteStreamRef.current) { node.srcObject = remoteStreamRef.current; node.play().catch(() => { }); } }} />
                ) : (
                  <video autoPlay playsInline muted ref={node => { (localVideoRef as any).current = node; if (node && localStreamRef.current && node.srcObject !== localStreamRef.current) { node.srcObject = localStreamRef.current; node.play().catch(() => { }); } }} />
                )}
              </div>
              {callState === "connected" && <div className="video-duration-overlay" style={{ zIndex: 11 }}>{fmtDuration(callDuration)}</div>}
            </div>

            {(!isVideoCall || callState !== "connected") && (
              <div className="call-info">
                <div className={`call-avatar ${callState !== "connected" ? "pulse-anim" : ""}`}>{callDisplayName?.[0]?.toUpperCase() || "?"}</div>
                <h2 className="call-name">{callDisplayName}</h2>
                <p className="call-status">
                  {callState === "incoming" ? `Incoming ${isVideoCall ? "Video" : "Voice"} Call…` : callState === "calling" ? "Calling…" : `Connected · ${fmtDuration(callDuration)}`}
                </p>
                {!isVideoCall && callState === "connected" && <p style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{isSpeaker ? "🔊 Speaker" : "📱 Earpiece"}</p>}
              </div>
            )}

            <div className="call-controls" style={isVideoCall && callState === "connected" ? { position: "absolute", bottom: 24, left: 0, right: 0, zIndex: 20, display: "flex", justifyContent: "center", gap: 16 } : {}}>
              {callState === "incoming" ? (
                <>
                  <button onClick={rejectCall} className="call-btn btn-reject"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
                  <button onClick={acceptCall} className="call-btn btn-accept"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg></button>
                </>
              ) : callState === "connected" ? (
                <>
                  <button onClick={toggleMute} className={`call-btn btn-secondary ${isMuted ? "active-mute" : ""}`}>
                    {isMuted ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                      : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>}
                  </button>
                  {isVideoCall && (
                    <button onClick={switchCamera} className="call-btn btn-secondary">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><polyline points="23 20 23 14 17 14" /><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" /></svg>
                    </button>
                  )}
                  <button onClick={toggleSpeaker} className={`call-btn btn-secondary ${!isSpeaker ? "active-mute" : ""}`}>
                    {isSpeaker
                      ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
                      : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>}
                  </button>
                  <button onClick={() => endCall(true)} className="call-btn btn-end"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
                </>
              ) : (
                <button onClick={() => endCall(true)} className="call-btn btn-end"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── FILE VIEWER ── */}
      {viewFile && (
        <div className="file-viewer-overlay" onClick={() => setViewFile(null)}>
          <button className="close-viewer" onClick={() => setViewFile(null)}>✕</button>
          <div className="viewer-content" onClick={e => e.stopPropagation()}>
            {viewFile.type === "image" && <img src={viewFile.url} alt="attachment" />}
            {viewFile.type === "video" && <video src={viewFile.url} controls autoPlay />}
            {viewFile.type === "avatar-circle" && <img src={viewFile.url} alt="Avatar" className="viewer-avatar-circle fullscreen-avatar img-cover rounded-circle" />}
          </div>
        </div>
      )}
    </div>
  );
}
