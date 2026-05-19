"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { relayPost } from "./relayClient";

const scheduleSchema = z.object({
  templatePrompt: z.string().min(10, "Prompt must be at least 10 characters"),
  cron: z
    .string()
    .regex(
      /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)$/,
      "Enter a valid 5-part cron expression (e.g. 0 9 * * 1)"
    ),
  timezone: z.string().min(1, "Timezone is required"),
});

type ScheduleFormData = z.infer<typeof scheduleSchema>;

const CRON_EXAMPLES = [
  { label: "Daily 9am", value: "0 9 * * *" },
  { label: "Mon 9am", value: "0 9 * * 1" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Weekdays 8am", value: "0 8 * * 1-5" },
];

interface Props {
  agentId: string;
  onCreated: () => void;
}

export function NewScheduleDialog({ agentId, onCreated }: Props) {
  const [open, setOpen] = React.useState(false);
  const form = useForm<ScheduleFormData>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: { templatePrompt: "", cron: "0 9 * * 1", timezone: "Asia/Kolkata" },
  });

  const mutation = useMutation({
    mutationFn: (data: ScheduleFormData) => relayPost("/schedules", agentId, data),
    onSuccess: () => {
      toast.success("Schedule created");
      setOpen(false);
      form.reset();
      onCreated();
    },
    onError: (err: Error) => toast.error(`Failed to create schedule: ${err.message}`),
  });

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-2" />
        New Schedule
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Scheduled Run</DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
              <FormField
                control={form.control}
                name="templatePrompt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Template Prompt</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="e.g. Build a PRD for our Q3 analytics dashboard feature..."
                        className="min-h-[100px] resize-none"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Sent to the PM workflow on each scheduled run. Be specific about the product area.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="cron"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cron Schedule</FormLabel>
                    <FormControl>
                      <Input placeholder="0 9 * * 1" {...field} className="font-mono" />
                    </FormControl>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {CRON_EXAMPLES.map((ex) => (
                        <button
                          key={ex.value}
                          type="button"
                          onClick={() => form.setValue("cron", ex.value, { shouldValidate: true })}
                          className="text-xs px-2 py-0.5 rounded bg-muted hover:bg-muted/80 text-muted-foreground transition-colors"
                        >
                          {ex.label}
                        </button>
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Timezone</FormLabel>
                    <FormControl>
                      <Input placeholder="Asia/Kolkata" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create Schedule
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
