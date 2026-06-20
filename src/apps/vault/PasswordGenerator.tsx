"use client";

import {
  Button,
  Checkbox,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mind-studio/ui";
import { useCallback, useState } from "react";
import type { AsyncCryptoCore } from "@/lib/platform";
import { copyWithAutoClear } from "@/lib/vault/clipboard";

/**
 * CSPRNG generator: a password (length + character-class toggles) via
 * `generatePassword`, or a diceware passphrase via `generatePassphrase`.
 * `onUse` lets a parent (the item editor) adopt the generated value.
 */
export function PasswordGenerator({
  core,
  onUse,
}: {
  core: AsyncCryptoCore;
  onUse?: (value: string) => void;
}) {
  const [length, setLength] = useState(20);
  const [upper, setUpper] = useState(true);
  const [lower, setLower] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [avoidAmbiguous, setAvoidAmbiguous] = useState(true);

  const [words, setWords] = useState(5);
  const [separator, setSeparator] = useState("-");

  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const genPassword = useCallback(async () => {
    setError(null);
    try {
      setValue(
        await core.generatePassword({ length, upper, lower, digits, symbols, avoidAmbiguous }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate");
    }
  }, [core, length, upper, lower, digits, symbols, avoidAmbiguous]);

  const genPassphrase = useCallback(async () => {
    setError(null);
    try {
      setValue(await core.generatePassphrase(words, separator));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate");
    }
  }, [core, words, separator]);

  return (
    <div className="space-y-4">
      <Tabs defaultValue="password">
        <TabsList>
          <TabsTrigger value="password">Password</TabsTrigger>
          <TabsTrigger value="passphrase">Passphrase</TabsTrigger>
        </TabsList>

        <TabsContent value="password" className="space-y-3 pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="gen-len">Length: {length}</Label>
            <input
              id="gen-len"
              type="range"
              min={8}
              max={64}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={upper} onCheckedChange={(v) => setUpper(v === true)} /> Uppercase
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={lower} onCheckedChange={(v) => setLower(v === true)} /> Lowercase
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={digits} onCheckedChange={(v) => setDigits(v === true)} /> Digits
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={symbols} onCheckedChange={(v) => setSymbols(v === true)} /> Symbols
            </label>
            <label className="col-span-2 flex items-center gap-2">
              <Checkbox
                checked={avoidAmbiguous}
                onCheckedChange={(v) => setAvoidAmbiguous(v === true)}
              />{" "}
              Avoid ambiguous (O/0, l/1)
            </label>
          </div>
          <Button type="button" variant="secondary" onClick={genPassword} className="w-full">
            Generate password
          </Button>
        </TabsContent>

        <TabsContent value="passphrase" className="space-y-3 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gen-words">Words</Label>
              <Input
                id="gen-words"
                type="number"
                min={3}
                max={12}
                value={words}
                onChange={(e) => setWords(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gen-sep">Separator</Label>
              <Input
                id="gen-sep"
                value={separator}
                maxLength={3}
                onChange={(e) => setSeparator(e.target.value)}
              />
            </div>
          </div>
          <Button type="button" variant="secondary" onClick={genPassphrase} className="w-full">
            Generate passphrase
          </Button>
        </TabsContent>
      </Tabs>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {value && (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <code className="block break-all font-mono text-sm">{value}</code>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyWithAutoClear(value)}
            >
              Copy (clears in 30s)
            </Button>
            {onUse && (
              <Button type="button" size="sm" onClick={() => onUse(value)}>
                Use this
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
