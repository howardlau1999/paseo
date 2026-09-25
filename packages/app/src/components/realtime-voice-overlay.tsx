import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff, Square, Volume2 } from "lucide-react-native";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { useVoiceTelemetry } from "@/contexts/voice-context";
import { useAppSettings } from "@/hooks/use-settings";
import { useToast } from "@/contexts/toast-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VolumeMeter } from "./volume-meter";

interface RealtimeVoiceOverlayProps {
  isMuted: boolean;
  isSwitching: boolean;
  onToggleMute: () => void;
  onStop: () => void;
}

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;
const PLAYBACK_GAIN_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

interface PlaybackGainMenuItemProps {
  gain: number;
  selected: boolean;
  onChange: (gain: number) => void;
}

function PlaybackGainMenuItem({ gain, selected, onChange }: PlaybackGainMenuItemProps) {
  const handleSelect = useCallback(() => {
    onChange(gain);
  }, [gain, onChange]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {Math.round(gain * 100)}%
    </DropdownMenuItem>
  );
}

export function RealtimeVoiceOverlay({
  isMuted,
  isSwitching,
  onToggleMute,
  onStop,
}: RealtimeVoiceOverlayProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { volume, isSpeaking } = useVoiceTelemetry();
  const { settings, isLoading, updateSettings } = useAppSettings();
  const toast = useToast();
  const [isVolumeSaving, setIsVolumeSaving] = useState(false);
  const playbackVolumeLabel = t("realtimeVoice.actions.playbackVolume");
  const handlePlaybackGainChange = useCallback(
    async (voicePlaybackGain: number) => {
      setIsVolumeSaving(true);
      try {
        await updateSettings({ voicePlaybackGain });
      } catch {
        toast.error(t("common.errors.unableToSave"));
      } finally {
        setIsVolumeSaving(false);
      }
    },
    [t, toast, updateSettings],
  );
  const muteButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.muteButton,
      isMuted ? styles.muteButtonMuted : undefined,
      isSwitching ? styles.buttonDisabled : undefined,
    ],
    [isMuted, isSwitching],
  );
  const stopButtonStyle = useMemo(
    () => [styles.actionButton, styles.stopButton, isSwitching ? styles.buttonDisabled : undefined],
    [isSwitching],
  );
  return (
    <View style={styles.container}>
      <View style={styles.meterContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={isMuted}
          isSpeaking={isSpeaking}
          orientation="horizontal"
        />
      </View>

      <View style={styles.actionsContainer}>
        <DropdownMenu compactMode="sheet">
          <DropdownMenuTrigger
            disabled={isLoading || isVolumeSaving || isSwitching}
            accessibilityRole="button"
            accessibilityLabel={`${playbackVolumeLabel}: ${Math.round(settings.voicePlaybackGain * 100)}%`}
            style={[styles.actionButton, styles.muteButton]}
          >
            {isVolumeSaving ? (
              <LoadingSpinner size="small" color={theme.colors.foreground} />
            ) : (
              <Volume2 size={theme.iconSize.lg} color={theme.colors.foreground} strokeWidth={2.5} />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" width={190} sheetTitle={playbackVolumeLabel}>
            {PLAYBACK_GAIN_OPTIONS.map((gain) => (
              <PlaybackGainMenuItem
                key={gain}
                gain={gain}
                selected={settings.voicePlaybackGain === gain}
                onChange={handlePlaybackGainChange}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Pressable
          onPress={onToggleMute}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={
            isMuted ? t("realtimeVoice.actions.unmute") : t("realtimeVoice.actions.mute")
          }
          style={muteButtonStyle}
        >
          {isMuted ? (
            <MicOff size={theme.iconSize.lg} color={theme.colors.palette.white} strokeWidth={2.5} />
          ) : (
            <Mic size={theme.iconSize.lg} color={theme.colors.foreground} strokeWidth={2.5} />
          )}
        </Pressable>

        <Pressable
          onPress={onStop}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={t("realtimeVoice.actions.stop")}
          style={stopButtonStyle}
        >
          {isSwitching ? (
            <LoadingSpinner size="small" color={theme.colors.palette.white} />
          ) : (
            <Square
              size={theme.iconSize.lg}
              color={theme.colors.palette.white}
              fill={theme.colors.palette.white}
              strokeWidth={2.5}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    height: FOOTER_HEIGHT,
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  meterContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  actionsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  muteButton: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  muteButtonMuted: {
    backgroundColor: theme.colors.palette.red[600],
    borderColor: theme.colors.palette.red[800],
  },
  stopButton: {
    backgroundColor: theme.colors.palette.red[600],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.red[800],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
