'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  api,
  type PricingStrategy,
  type PublishDraftView,
  type PublishPreflightCheck,
  type PublishPreflightRequest,
  type PublishTaskSummary,
  type SavePublishDraftRequest,
} from '@/lib/api';
import {
  clearPublishAttempt,
  draftWriteExpectation,
  getPublishAttempt,
  recoverPublishAttempt,
  type PublishAttempt,
  type PublishAttemptRecovery,
} from '@/lib/publish-draft-client';
import {
  productPublishReturnTo,
  readOAuthCallbackResult,
  settingsHrefWithReturnTo,
  type OAuthCallbackResult,
} from '@/lib/oauth-return';
import {
  constrainAuditTestAiOptions,
  constrainAuditTestShopIds,
  nextAuditTestShopSelection,
} from '@/lib/audit-test-scope';
import { isAuditTestMode } from '@/lib/environment';

interface Props {
  sourceProductId: string;
  availability: 'available' | 'out_of_stock' | 'offline' | 'unknown';
  totalStock: number;
  titleOverride?: string;
  titlePlatformLabel?: string;
  onRestoreTitle?: (title: string | null) => void;
  onClearTitle?: () => void;
}

/** 一键铺货面板：选店铺 + 加价 + AI 标题 → 发布，展示每店结果 */
export function PublishPanel({
  sourceProductId,
  availability,
  totalStock,
  titleOverride,
  titlePlatformLabel,
  onRestoreTitle,
  onClearTitle,
}: Props) {
  const queryClient = useQueryClient();
  const publishAttempts = useRef(new Map<string, PublishAttempt>());
  const draftWriteInFlight = useRef(false);
  const publishOutcomeUnresolvedRef = useRef(false);
  const attemptRecoveryRun = useRef<{
    sourceProductId: string;
    version: number;
    promise: Promise<PublishAttemptRecovery<PublishTaskSummary>>;
  } | null>(null);
  const oauthCallbackRef = useRef<OAuthCallbackResult | null | undefined>(undefined);
  const draftHydrated = useRef(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pricingMode, setPricingMode] = useState<PricingStrategy['mode']>('fixed_markup');
  const [markup, setMarkup] = useState(50);
  const [targetMargin, setTargetMargin] = useState(30);
  const [competitorLow, setCompetitorLow] = useState('');
  const [competitorHigh, setCompetitorHigh] = useState('');
  const [estimatedShipping, setEstimatedShipping] = useState(4);
  const [platformFeeRate, setPlatformFeeRate] = useState(5);
  const [rewriteTitle, setRewriteTitle] = useState(true);
  const [rewriteDetail, setRewriteDetail] = useState(false);
  const [removeWatermark, setRemoveWatermark] = useState(false);
  const [relightImages, setRelightImages] = useState(false);
  const [backgroundStyle, setBackgroundStyle] = useState<
    '' | 'white_studio' | 'warm_lifestyle' | 'cool_minimal'
  >('');
  const [draftFeedback, setDraftFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [oauthFeedback, setOAuthFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [draftBase, setDraftBase] = useState<PublishDraftView | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const [resolvingDraftConflict, setResolvingDraftConflict] = useState(false);
  const [attemptRecoveryStatus, setAttemptRecoveryStatus] = useState<
    'checking' | 'complete' | 'error'
  >('checking');
  const [attemptRecoveryVersion, setAttemptRecoveryVersion] = useState(0);
  const [recoveredTask, setRecoveredTask] = useState<PublishTaskSummary | null>(null);
  const [publishOutcomeUnresolved, setPublishOutcomeUnresolved] = useState(false);

  const shops = useQuery({ queryKey: ['shops'], queryFn: () => api.shops(), enabled: open });
  const draftQuery = useQuery({
    queryKey: ['publishDraft'],
    queryFn: () => api.publishDraft(),
    enabled: attemptRecoveryStatus === 'complete' && !recoveredTask,
    staleTime: 0,
  });
  const saveDraft = useMutation({
    mutationFn: (body: SavePublishDraftRequest) => api.savePublishDraft(body),
    onSuccess: (draft) => {
      clearPublishAttempt(sourceProductId, publishAttempts.current);
      queryClient.setQueryData(['publishDraft'], draft);
      setDraftBase(draft);
      setDraftConflict(false);
      setDraftFeedback({ type: 'success', message: '草稿已保存；恢复后仍会重新试算和检查。' });
    },
    onError: (error) => {
      const apiError = error as ApiError;
      if (apiError.code === 'PUBLISH_DRAFT_VERSION_CONFLICT') {
        setDraftConflict(true);
        void queryClient.invalidateQueries({ queryKey: ['publishDraft'] });
        setDraftFeedback({
          type: 'error',
          message: '草稿已在另一页面更新。请选择载入服务端版本，或明确放弃后重新开始。',
        });
        return;
      }
      setDraftFeedback({ type: 'error', message: `草稿保存失败：${apiError.message}` });
    },
  });
  const preflight = useMutation({
    mutationFn: ({ request }: { request: PublishPreflightRequest; inputFingerprint: string }) =>
      api.publishPreflight(request),
  });
  const resetPreflight = preflight.reset;
  const pricingStrategy = buildPricingStrategy({
    pricingMode,
    markup,
    targetMargin,
    competitorLow,
    competitorHigh,
    estimatedShipping,
    platformFeeRate,
  });
  const pricingInputValid =
    estimatedShipping >= 0 &&
    platformFeeRate >= 0 &&
    platformFeeRate < 100 &&
    (pricingMode !== 'profit_target' ||
      (targetMargin > 0 && targetMargin + platformFeeRate < 100)) &&
    (pricingMode !== 'competitor_anchor' ||
      (Number(competitorLow) > 0 && Number(competitorHigh) >= Number(competitorLow)));
  const pricingPreview = useMutation({
    mutationFn: (input: { sourceProductId: string; pricingStrategy: PricingStrategy }) =>
      api.pricingPreview(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['activation'] }),
  });
  const resetPricingPreview = pricingPreview.reset;
  const pricingPreviewInput = { sourceProductId, pricingStrategy };
  const pricingPreviewIsCurrent =
    pricingPreview.isSuccess &&
    JSON.stringify(pricingPreview.variables) === JSON.stringify(pricingPreviewInput);
  const currentPricingPreview = pricingPreviewIsCurrent ? pricingPreview.data : undefined;

  const aiOptions = constrainAuditTestAiOptions(
    {
      ...(titleOverride ? { titleOverride } : {}),
      rewriteTitle: titleOverride ? false : rewriteTitle,
      rewriteDetail,
      removeWatermark,
      relightImages,
      ...(backgroundStyle ? { backgroundStyle } : {}),
    },
    isAuditTestMode,
  );
  const publishRequest: PublishPreflightRequest = {
    sourceProductId,
    targetShopIds: constrainAuditTestShopIds([...selected].sort(), isAuditTestMode),
    pricingStrategy,
    aiOptions,
    ...(currentPricingPreview
      ? { pricingPreviewToken: currentPricingPreview.pricingPreviewToken }
      : {}),
  };
  const draftPayload = {
    sourceProductId,
    targetShopIds: publishRequest.targetShopIds,
    pricingStrategy,
    aiOptions: publishRequest.aiOptions,
  } satisfies Omit<SavePublishDraftRequest, 'expectedRevision' | 'expectedClientRequestId'>;
  const draftInputFingerprint = publishDraftFingerprint(draftPayload);
  const currentDraft = draftBase?.sourceProductId === sourceProductId ? draftBase : null;
  const foreignDraft =
    !draftConflict && !draftBase && draftQuery.data?.sourceProductId !== sourceProductId
      ? draftQuery.data
      : null;
  const draftMatchesInput =
    !!currentDraft && publishDraftFingerprint(currentDraft) === draftInputFingerprint;
  const attemptRecoveryBlocked = attemptRecoveryStatus !== 'complete' || !!recoveredTask;
  const publishInputFingerprint = JSON.stringify({ publishRequest, availability, totalStock });
  const preflightIsCurrent =
    preflight.isSuccess && preflight.variables?.inputFingerprint === publishInputFingerprint;
  const currentPreflight = preflightIsCurrent ? preflight.data : undefined;
  const pricingConfirmationMatches =
    currentPreflight?.pricingPreviewConfirmed === true &&
    currentPreflight.sourcePricingFingerprint === currentPricingPreview?.sourcePricingFingerprint;
  const readyToPublish =
    !draftConflict &&
    !attemptRecoveryBlocked &&
    currentPreflight?.ready === true &&
    pricingConfirmationMatches &&
    draftMatchesInput;

  const restoreDraftForm = useCallback(
    (draft: PublishDraftView) => {
      const pricing = pricingFormFromDraft(draft.pricingStrategy);
      setSelected(constrainAuditTestShopIds([...draft.targetShopIds], isAuditTestMode));
      setPricingMode(pricing.pricingMode);
      setMarkup(pricing.markup);
      setTargetMargin(pricing.targetMargin);
      setCompetitorLow(pricing.competitorLow);
      setCompetitorHigh(pricing.competitorHigh);
      setEstimatedShipping(pricing.estimatedShipping);
      setPlatformFeeRate(pricing.platformFeeRate);
      setRewriteTitle(draft.aiOptions?.rewriteTitle ?? true);
      setRewriteDetail(draft.aiOptions?.rewriteDetail ?? false);
      setRemoveWatermark(isAuditTestMode ? false : (draft.aiOptions?.removeWatermark ?? false));
      setRelightImages(isAuditTestMode ? false : (draft.aiOptions?.relightImages ?? false));
      setBackgroundStyle(isAuditTestMode ? '' : (draft.aiOptions?.backgroundStyle ?? ''));
      onRestoreTitle?.(draft.aiOptions?.titleOverride ?? null);
      resetPricingPreview();
      resetPreflight();
      setOpen(true);
    },
    [onRestoreTitle, resetPreflight, resetPricingPreview],
  );

  const resetDraftForm = useCallback(() => {
    setSelected([]);
    setPricingMode('fixed_markup');
    setMarkup(50);
    setTargetMargin(30);
    setCompetitorLow('');
    setCompetitorHigh('');
    setEstimatedShipping(4);
    setPlatformFeeRate(5);
    setRewriteTitle(true);
    setRewriteDetail(false);
    setRemoveWatermark(false);
    setRelightImages(false);
    setBackgroundStyle('');
    onRestoreTitle?.(null);
    resetPricingPreview();
    resetPreflight();
    setOpen(true);
  }, [onRestoreTitle, resetPreflight, resetPricingPreview]);

  const persistDraft = async (
    payload: Omit<
      SavePublishDraftRequest,
      'expectedRevision' | 'expectedClientRequestId'
    > = draftPayload,
    allowReplace = false,
  ): Promise<PublishDraftView> => {
    if (publishOutcomeUnresolvedRef.current) {
      setDraftFeedback({
        type: 'error',
        message: '发布结果尚未确认，系统不会改写草稿或创建新任务。',
      });
      throw new Error('publish outcome must be resolved before saving');
    }
    if (draftWriteInFlight.current) {
      throw new Error('another publish draft write is still in progress');
    }
    if (attemptRecoveryBlocked) {
      setDraftFeedback({
        type: 'error',
        message: recoveredTask
          ? '已恢复原铺货任务，请前往铺货记录查看；当前页面不会再次创建任务。'
          : attemptRecoveryStatus === 'checking'
            ? '正在核对上次发布结果，请稍候。'
            : '暂时无法确认上次发布是否成功，请先重新核对，系统不会创建新任务。',
      });
      throw new Error('publish attempt recovery is required before saving');
    }
    if (draftConflict) {
      setDraftFeedback({
        type: 'error',
        message: '请先处理草稿冲突，旧页面内容不会覆盖服务端版本。',
      });
      throw new Error('publish draft conflict requires resolution');
    }
    const existing = draftBase ?? (allowReplace ? draftQuery.data : null) ?? null;
    if (!draftBase && draftQuery.data?.sourceProductId === sourceProductId) {
      setDraftConflict(true);
      setDraftFeedback({
        type: 'error',
        message: '发现尚未载入的服务端草稿，请先载入后再继续。',
      });
      throw new Error('server publish draft must be loaded before saving');
    }
    if (existing && existing.sourceProductId !== sourceProductId && !allowReplace) {
      setDraftFeedback({
        type: 'error',
        message: '另一件商品已有草稿。请先继续原草稿，或明确改用当前商品。',
      });
      throw new Error('publish draft replacement requires confirmation');
    }
    draftWriteInFlight.current = true;
    try {
      return await saveDraft.mutateAsync({
        ...draftWriteExpectation(existing),
        ...payload,
      });
    } finally {
      draftWriteInFlight.current = false;
    }
  };

  const loadServerDraft = async () => {
    if (
      attemptRecoveryBlocked ||
      publishOutcomeUnresolvedRef.current ||
      draftWriteInFlight.current
    ) {
      return;
    }
    draftWriteInFlight.current = true;
    setResolvingDraftConflict(true);
    try {
      const result = await draftQuery.refetch();
      if (result.isError) throw result.error;
      const latest = result.data ?? null;
      clearPublishAttempt(sourceProductId, publishAttempts.current);
      draftHydrated.current = true;
      if (!latest) {
        setDraftBase(null);
        setDraftConflict(false);
        resetDraftForm();
        setDraftFeedback({
          type: 'success',
          message: '服务端当前没有草稿，已安全地从空白状态重新开始。',
        });
        return;
      }
      if (latest.sourceProductId !== sourceProductId) {
        window.location.assign(
          `/products?id=${encodeURIComponent(latest.sourceProductId)}#publish`,
        );
        return;
      }
      setDraftBase(latest);
      setDraftConflict(false);
      restoreDraftForm(latest);
      setDraftFeedback({
        type: 'success',
        message: '已载入服务端最新草稿；请重新试算并检查发布条件。',
      });
    } catch (error) {
      setDraftFeedback({
        type: 'error',
        message: `载入服务端草稿失败：${(error as Error).message}`,
      });
    } finally {
      draftWriteInFlight.current = false;
      setResolvingDraftConflict(false);
    }
  };

  const restartDraft = async () => {
    if (
      attemptRecoveryBlocked ||
      publishOutcomeUnresolvedRef.current ||
      draftWriteInFlight.current
    ) {
      return;
    }
    draftWriteInFlight.current = true;
    setResolvingDraftConflict(true);
    try {
      const result = await draftQuery.refetch();
      if (result.isError) throw result.error;
      const latest = result.data ?? null;
      if (latest) await api.deletePublishDraft(latest.revision, latest.clientRequestId);
      clearPublishAttempt(sourceProductId, publishAttempts.current);
      queryClient.setQueryData(['publishDraft'], null);
      draftHydrated.current = true;
      setDraftBase(null);
      setDraftConflict(false);
      resetDraftForm();
      setDraftFeedback({ type: 'success', message: '服务端草稿已放弃，可以重新开始。' });
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.code === 'PUBLISH_DRAFT_VERSION_CONFLICT') {
        void queryClient.invalidateQueries({ queryKey: ['publishDraft'] });
      }
      setDraftFeedback({
        type: 'error',
        message:
          apiError.code === 'PUBLISH_DRAFT_VERSION_CONFLICT'
            ? '草稿在处理期间再次变化，请重新选择载入或放弃。'
            : `重新开始失败：${apiError.message}`,
      });
    } finally {
      draftWriteInFlight.current = false;
      setResolvingDraftConflict(false);
    }
  };

  const runPreflight = async () => {
    const request = publishRequest;
    const inputFingerprint = publishInputFingerprint;
    const payload = draftPayload;
    try {
      await persistDraft(payload);
      preflight.mutate({ request, inputFingerprint });
    } catch {
      // 保存失败时不得继续使用未持久化输入做发布确认。
    }
  };

  const navigateAfterDraftSave = async (href: string) => {
    try {
      await persistDraft();
      const destination =
        href === '/settings#shops'
          ? settingsHrefWithReturnTo(href, productPublishReturnTo(sourceProductId))
          : href;
      window.location.assign(destination);
    } catch {
      // 保留当前页面和输入，让用户先处理草稿冲突或保存失败。
    }
  };

  useEffect(() => {
    resetPreflight();
  }, [resetPreflight, publishInputFingerprint]);

  useEffect(() => {
    let cancelled = false;
    setAttemptRecoveryStatus('checking');
    setRecoveredTask(null);

    let run = attemptRecoveryRun.current;
    if (!run || run.sourceProductId !== sourceProductId || run.version !== attemptRecoveryVersion) {
      run = {
        sourceProductId,
        version: attemptRecoveryVersion,
        promise: recoverPublishAttempt(
          sourceProductId,
          publishAttempts.current,
          async (clientRequestId) => {
            try {
              return await api.publishTaskByClientRequestId(clientRequestId);
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) return null;
              throw error;
            }
          },
        ),
      };
      attemptRecoveryRun.current = run;
    }

    void run.promise
      .then((result) => {
        if (cancelled) return;
        if (result.kind === 'none' && publishOutcomeUnresolvedRef.current) {
          setAttemptRecoveryStatus('error');
          setOpen(true);
          return;
        }
        if (result.kind === 'recovered') {
          setRecoveredTask(result.task);
          setOpen(true);
        }
        setAttemptRecoveryStatus('complete');
        if (result.kind !== 'none') {
          publishOutcomeUnresolvedRef.current = false;
          setPublishOutcomeUnresolved(false);
          clearPublishAttempt(sourceProductId, publishAttempts.current);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAttemptRecoveryStatus('error');
        setOpen(true);
      });

    return () => {
      cancelled = true;
    };
  }, [attemptRecoveryVersion, sourceProductId]);

  useEffect(() => {
    if (
      attemptRecoveryStatus !== 'complete' ||
      recoveredTask ||
      !draftQuery.isSuccess ||
      draftQuery.isFetching ||
      draftHydrated.current
    ) {
      return;
    }
    draftHydrated.current = true;
    const draft = draftQuery.data;
    if (!draft || draft.sourceProductId !== sourceProductId) return;
    setDraftBase(draft);
    restoreDraftForm(draft);
    setDraftFeedback({
      type: 'success',
      message: '已恢复服务端草稿。为防止价格或货源变化，请重新试算并检查发布条件。',
    });
  }, [
    attemptRecoveryStatus,
    draftQuery.data,
    draftQuery.isFetching,
    draftQuery.isSuccess,
    recoveredTask,
    restoreDraftForm,
    sourceProductId,
  ]);

  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === '#publish') setOpen(true);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [sourceProductId]);

  useEffect(() => {
    if (oauthCallbackRef.current === undefined) {
      oauthCallbackRef.current = readOAuthCallbackResult(window.location.href);
      if (oauthCallbackRef.current) {
        window.history.replaceState({}, '', oauthCallbackRef.current.cleanHref);
      }
    }
    const callback = oauthCallbackRef.current;
    if (!callback) return;
    setOpen(true);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['activation'] }),
      queryClient.invalidateQueries({ queryKey: ['publishDraft'] }),
    ]);

    if (callback.kind === 'unverified_error') {
      const platformLabel = callback.platform === 'douyin' ? '抖店' : '1688 买家账号';
      setOAuthFeedback({
        type: 'error',
        message: `${platformLabel}授权未完成，请返回店铺管理重试。`,
      });
      return;
    }

    let cancelled = false;
    void queryClient
      .fetchQuery({
        queryKey: ['oauthResult', callback.token],
        queryFn: () => api.consumeOAuthResult(callback.token),
        staleTime: Number.POSITIVE_INFINITY,
      })
      .then((result) => {
        if (cancelled) return;
        const platformLabel = result.platform === 'douyin' ? '抖店' : '1688 买家账号';
        setOAuthFeedback({
          type: result.result === 'success' ? 'success' : 'error',
          message:
            result.result === 'success'
              ? result.shopName
                ? `${platformLabel}「${result.shopName}」授权成功，已返回原商品并恢复铺货草稿。`
                : `${platformLabel}授权成功，已返回原商品并恢复铺货草稿。`
              : result.message || `${platformLabel}授权未完成，请返回店铺管理重试。`,
        });
        if (result.result === 'success') {
          void queryClient.invalidateQueries({ queryKey: ['shops'] });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setOAuthFeedback({
          type: 'error',
          message: '授权结果暂时无法确认，请返回店铺管理查看状态。',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);
  const sellerShops =
    shops.data?.filter((shop) => shop.role === 'seller' && shop.status === 'active') ?? [];
  const visibleSellerIds = new Set(sellerShops.map((shop) => shop.id));
  const unavailableSelectedShopIds = selected.filter((id) => !visibleSellerIds.has(id));
  const publish = useMutation({
    mutationFn: () => {
      if (publishOutcomeUnresolvedRef.current) {
        throw new ApiError(409, 'PUBLISH_REQUEST_IN_FLIGHT', '已有铺货请求正在等待结果');
      }
      if (draftWriteInFlight.current) {
        throw new ApiError(
          409,
          'PUBLISH_DRAFT_WRITE_IN_PROGRESS',
          '草稿操作正在进行，请稍后再发布',
        );
      }
      if (attemptRecoveryBlocked) {
        throw new ApiError(
          409,
          'PUBLISH_ATTEMPT_RECOVERY_REQUIRED',
          '上次发布结果尚未核对，系统不会创建新任务',
        );
      }
      if (!currentDraft || !draftMatchesInput) {
        throw new ApiError(
          409,
          'PUBLISH_DRAFT_STALE',
          '当前输入尚未保存为最新草稿，请重新检查发布条件',
        );
      }
      const requestIdentity = {
        sourceProductId: publishRequest.sourceProductId,
        targetShopIds: publishRequest.targetShopIds,
        pricingStrategy: publishRequest.pricingStrategy,
        aiOptions: publishRequest.aiOptions,
        pricingConfirmation: currentPricingPreview
          ? {
              costPrice: currentPricingPreview.costPrice,
              suggestedPrice: currentPricingPreview.suggestedPrice,
              sourcePricingFingerprint: currentPricingPreview.sourcePricingFingerprint,
            }
          : null,
      };
      const attempt = getPublishAttempt(
        sourceProductId,
        requestIdentity,
        currentDraft,
        publishAttempts.current,
      );
      publishOutcomeUnresolvedRef.current = true;
      setPublishOutcomeUnresolved(true);
      return api.publish({
        ...publishRequest,
        clientRequestId: attempt.clientRequestId,
        draftRevision: attempt.draftRevision,
      });
    },
    onSuccess: async () => {
      publishOutcomeUnresolvedRef.current = false;
      setPublishOutcomeUnresolved(false);
      clearPublishAttempt(sourceProductId, publishAttempts.current);
      queryClient.setQueryData(['publishDraft'], null);
      setDraftBase(null);
      setDraftConflict(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['activation'] }),
        queryClient.invalidateQueries({ queryKey: ['publishTasks'] }),
      ]);
    },
    onError: (error) => {
      const code = (error as ApiError).code;
      if (code !== 'PUBLISH_REQUEST_IN_FLIGHT' && publishOutcomeUnresolvedRef.current) {
        setAttemptRecoveryStatus('checking');
        setAttemptRecoveryVersion((version) => version + 1);
      }
      if (code?.startsWith('PRICING_PREVIEW_')) {
        pricingPreview.reset();
        resetPreflight();
      }
      if (code === 'PUBLISH_DRAFT_STALE') {
        setDraftConflict(true);
        void queryClient.invalidateQueries({ queryKey: ['publishDraft'] });
        resetPreflight();
        setDraftFeedback({
          type: 'error',
          message: '草稿已变化或任务结果需要恢复，请重新载入草稿并检查，系统未创建第二个任务。',
        });
      }
    },
  });

  const toggle = (id: string) => {
    resetPreflight();
    setSelected((current) => nextAuditTestShopSelection(current, id, isAuditTestMode));
  };

  const resetPricingConfirmation = () => {
    pricingPreview.reset();
    resetPreflight();
  };

  const unavailableMessage = sourceUnavailableMessage(availability);

  if (!open) {
    return (
      <div id="publish" className="scroll-mt-24">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!!unavailableMessage}
          className="primary-button mt-4 w-full"
        >
          {unavailableMessage ?? `一键铺货 · 可售库存 ${totalStock}`}
        </button>
      </div>
    );
  }

  return (
    <div id="publish" className="ledger-panel mt-4 scroll-mt-24 p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">一键铺货</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="quiet-button min-h-11 text-xs"
        >
          收起
        </button>
      </div>

      {oauthFeedback ? (
        <div
          role="status"
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
            oauthFeedback.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {oauthFeedback.message}
        </div>
      ) : null}

      {attemptRecoveryStatus === 'checking' ? (
        <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          正在核对上次发布结果，在确认前不会创建新任务…
        </div>
      ) : null}
      {attemptRecoveryStatus === 'error' ? (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-medium">暂时无法确认上次发布是否成功。</p>
          <p className="mt-1 text-xs text-red-700">
            可能是网络或服务异常。为避免重复铺货，确认结果前不会保存新草稿或创建新任务。
          </p>
          <button
            type="button"
            onClick={() => {
              setAttemptRecoveryStatus('checking');
              setAttemptRecoveryVersion((version) => version + 1);
            }}
            className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium"
          >
            重新核对
          </button>
        </div>
      ) : null}
      {recoveredTask ? (
        <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          <p className="font-medium">已恢复原铺货任务，没有重复创建。</p>
          <p className="mt-1 text-xs text-blue-700">
            当前状态：{recoveredTask.status} · 任务 ID：{recoveredTask.taskId}
          </p>
          <a href="/published" className="mt-2 inline-block text-xs font-medium underline">
            查看我的铺货 →
          </a>
        </div>
      ) : null}

      {!recoveredTask && draftQuery.isLoading ? (
        <p className="mb-3 text-xs text-zinc-400">正在读取已保存草稿…</p>
      ) : null}
      {!recoveredTask && draftQuery.isError ? (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <p>草稿暂时无法读取。为避免覆盖其他页面的内容，恢复前不会进入最终发布确认。</p>
          <button
            type="button"
            onClick={() => void draftQuery.refetch()}
            disabled={draftQuery.isFetching}
            className="mt-2 rounded-md border border-red-300 bg-white px-2.5 py-1 font-medium disabled:opacity-50"
          >
            {draftQuery.isFetching ? '正在重新读取…' : '重新读取草稿'}
          </button>
        </div>
      ) : null}
      {!recoveredTask && draftConflict ? (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-medium">服务端草稿已变化，当前页面的旧内容不会自动覆盖它。</p>
          <p className="mt-1 text-xs text-red-700">
            载入服务端版本会放弃本页未保存修改；重新开始会明确删除服务端最新草稿。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadServerDraft()}
              disabled={
                resolvingDraftConflict ||
                draftQuery.isFetching ||
                attemptRecoveryBlocked ||
                publishOutcomeUnresolved
              }
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              载入服务端版本
            </button>
            <button
              type="button"
              onClick={() => void restartDraft()}
              disabled={
                resolvingDraftConflict ||
                draftQuery.isFetching ||
                attemptRecoveryBlocked ||
                publishOutcomeUnresolved
              }
              className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              放弃服务端草稿并重新开始
            </button>
          </div>
        </div>
      ) : null}
      {!recoveredTask && foreignDraft ? (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p>商品 {foreignDraft.sourceProductId} 已有服务端草稿，系统不会静默覆盖。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={`/products?id=${encodeURIComponent(foreignDraft.sourceProductId)}#publish`}
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium"
            >
              继续原草稿
            </a>
            <button
              type="button"
              onClick={() => void persistDraft(draftPayload, true)}
              disabled={saveDraft.isPending || attemptRecoveryBlocked || publishOutcomeUnresolved}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              改用当前商品
            </button>
          </div>
        </div>
      ) : null}
      {!recoveredTask &&
      !draftConflict &&
      !foreignDraft &&
      !draftQuery.isLoading &&
      !draftQuery.isError ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          <span>
            {currentDraft
              ? draftMatchesInput
                ? `草稿已保存 · ${formatDraftTime(currentDraft.updatedAt)}`
                : '当前有未保存的草稿更改'
              : '当前商品尚未保存草稿'}
          </span>
          <button
            type="button"
            onClick={() => void persistDraft()}
            disabled={
              saveDraft.isPending ||
              draftMatchesInput ||
              draftConflict ||
              attemptRecoveryBlocked ||
              publishOutcomeUnresolved
            }
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-700 disabled:opacity-50"
          >
            {saveDraft.isPending ? '保存中…' : draftMatchesInput ? '已保存' : '保存草稿'}
          </button>
        </div>
      ) : null}
      {draftFeedback ? (
        <p
          role="status"
          className={`mb-3 text-xs ${draftFeedback.type === 'error' ? 'text-red-600' : 'text-green-700'}`}
        >
          {draftFeedback.message}
        </p>
      ) : null}

      {unavailableMessage ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {unavailableMessage}，系统已禁止创建新的铺货任务。
        </div>
      ) : null}

      {!recoveredTask && shops.isLoading && <p className="text-sm text-zinc-400">加载店铺…</p>}
      {!recoveredTask &&
        shops.data &&
        sellerShops.length === 0 &&
        unavailableSelectedShopIds.length === 0 && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
            <p>还没有可用于铺货的销售店铺。</p>
            <button
              type="button"
              onClick={() => void navigateAfterDraftSave('/settings#shops')}
              disabled={
                saveDraft.isPending ||
                draftConflict ||
                !!foreignDraft ||
                attemptRecoveryBlocked ||
                publishOutcomeUnresolved
              }
              className="mt-2 font-medium underline disabled:opacity-50"
            >
              保存草稿并前往店铺管理 →
            </button>
          </div>
        )}

      {!recoveredTask &&
        shops.data &&
        (sellerShops.length > 0 || unavailableSelectedShopIds.length > 0) && (
          <>
            <p className="mb-2 text-xs text-zinc-500">
              {isAuditTestMode ? '选择 1 个目标店铺（审核测试版）' : '选择目标店铺'}
            </p>
            <div className="mb-3 space-y-1.5">
              {sellerShops.map((s) => (
                <label
                  key={s.id}
                  className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(s.id)}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="font-medium">{s.shopName}</span>
                  <span className="text-zinc-400">{s.platformLabel}</span>
                </label>
              ))}
              {unavailableSelectedShopIds.map((shopId) => (
                <label
                  key={shopId}
                  className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-amber-700"
                >
                  <input type="checkbox" checked onChange={() => toggle(shopId)} />
                  <span className="font-medium">已保存店铺 {shopId}</span>
                  <span className="text-amber-600">当前不可用，可取消选择或重新授权</span>
                </label>
              ))}
            </div>

            <fieldset className="mb-3 rounded-xl border border-zinc-200 p-3">
              <legend className="px-1 text-xs font-medium text-zinc-500">定价策略</legend>
              <div className="space-y-3">
                <select
                  value={pricingMode}
                  onChange={(event) => {
                    setPricingMode(event.target.value as PricingStrategy['mode']);
                    resetPricingConfirmation();
                  }}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
                >
                  <option value="fixed_markup">固定加价</option>
                  <option value="profit_target">目标毛利 · 需扩容权限</option>
                  <option value="competitor_anchor">竞品对标 · 需扩容权限</option>
                </select>

                {pricingMode === 'fixed_markup' ? (
                  <NumberField
                    label="加价比例"
                    value={markup}
                    suffix="%"
                    min={0}
                    max={500}
                    onChange={(value) => {
                      setMarkup(value);
                      resetPricingConfirmation();
                    }}
                  />
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <NumberField
                        label="预估运费"
                        value={estimatedShipping}
                        prefix="¥"
                        min={0}
                        onChange={(value) => {
                          setEstimatedShipping(value);
                          resetPricingConfirmation();
                        }}
                      />
                      <NumberField
                        label="平台费率"
                        value={platformFeeRate}
                        suffix="%"
                        min={0}
                        max={50}
                        onChange={(value) => {
                          setPlatformFeeRate(value);
                          resetPricingConfirmation();
                        }}
                      />
                    </div>
                    {pricingMode === 'profit_target' ? (
                      <NumberField
                        label="目标毛利率"
                        value={targetMargin}
                        suffix="%"
                        min={1}
                        max={80}
                        onChange={(value) => {
                          setTargetMargin(value);
                          resetPricingConfirmation();
                        }}
                      />
                    ) : (
                      <div>
                        <div className="mb-1 text-xs text-zinc-500">竞品售价区间</div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0.01}
                            step="0.01"
                            value={competitorLow}
                            placeholder="最低价"
                            onChange={(event) => {
                              setCompetitorLow(event.target.value);
                              resetPricingConfirmation();
                            }}
                            className="min-w-0 flex-1 rounded border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
                          />
                          <span className="text-zinc-400">—</span>
                          <input
                            type="number"
                            min={0.01}
                            step="0.01"
                            value={competitorHigh}
                            placeholder="最高价"
                            onChange={(event) => {
                              setCompetitorHigh(event.target.value);
                              resetPricingConfirmation();
                            }}
                            className="min-w-0 flex-1 rounded border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
                          />
                        </div>
                        <p className="mt-1 text-[11px] text-zinc-400">
                          请填写真实平台同款价格，不使用经验值冒充竞品行情。
                        </p>
                      </div>
                    )}
                  </>
                )}

                <button
                  type="button"
                  onClick={() => {
                    resetPreflight();
                    pricingPreview.mutate(pricingPreviewInput);
                  }}
                  disabled={pricingPreview.isPending || !pricingInputValid}
                  className="w-full rounded-lg border border-brand-200 bg-brand-50 py-2 text-xs font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-50"
                >
                  {pricingPreview.isPending ? '计算中…' : '试算售价与保本价'}
                </button>

                {pricingPreview.isError ? (
                  <p className="text-xs text-red-600">
                    {(pricingPreview.error as ApiError).message}
                  </p>
                ) : null}
                {currentPricingPreview ? <PricingQuoteCard quote={currentPricingPreview} /> : null}
              </div>
            </fieldset>

            <fieldset className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3">
              <legend className="px-1 text-xs font-medium text-zinc-500">AI 内容优化</legend>
              {titleOverride ? (
                <div className="mb-3 rounded-lg border border-green-200 bg-green-50 p-2.5 text-xs text-green-800">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        已选{titlePlatformLabel ? ` ${titlePlatformLabel}` : ''}标题
                      </div>
                      <div className="mt-1 leading-5">{titleOverride}</div>
                      <div className="mt-1 text-green-700">提交时会按实际目标店铺再次校验。</div>
                    </div>
                    <button
                      type="button"
                      onClick={onClearTitle}
                      className="shrink-0 rounded px-1.5 py-0.5 text-green-700 hover:bg-green-100"
                    >
                      清除
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!titleOverride && rewriteTitle}
                    onChange={(e) => {
                      resetPreflight();
                      setRewriteTitle(e.target.checked);
                    }}
                    disabled={!!titleOverride}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-zinc-700">优化标题</span>
                    <span className="ml-1 text-xs text-zinc-400">
                      {titleOverride ? '已使用上方选中的候选标题' : '按目标平台 SEO 改写'}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={rewriteDetail}
                    onChange={(e) => {
                      resetPreflight();
                      setRewriteDetail(e.target.checked);
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-zinc-700">生成结构化详情</span>
                    <span className="ml-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-600">
                      需扩容权限
                    </span>
                    <span className="ml-1 text-xs text-zinc-400">3 段以上，自动规避夸大词</span>
                  </span>
                </label>
                {isAuditTestMode ? null : (
                  <div className="border-t border-zinc-200 pt-2">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-xs font-medium text-zinc-600">主图处理</span>
                      <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">
                        需扩容权限
                      </span>
                    </div>
                    <div className="space-y-2">
                      <label className="flex cursor-pointer items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={removeWatermark}
                          onChange={(e) => {
                            resetPreflight();
                            setRemoveWatermark(e.target.checked);
                          }}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium text-zinc-700">检测并去除水印</span>
                          <span className="ml-1 text-xs text-zinc-400">检测、蒙版与重绘</span>
                        </span>
                      </label>
                      <label className="flex cursor-pointer items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={relightImages}
                          onChange={(e) => {
                            resetPreflight();
                            setRelightImages(e.target.checked);
                          }}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium text-zinc-700">优化光线</span>
                          <span className="ml-1 text-xs text-zinc-400">统一商品明暗与质感</span>
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <span className="text-zinc-500">替换背景</span>
                        <select
                          value={backgroundStyle}
                          onChange={(e) => {
                            resetPreflight();
                            setBackgroundStyle(
                              e.target.value as
                                | ''
                                | 'white_studio'
                                | 'warm_lifestyle'
                                | 'cool_minimal',
                            );
                          }}
                          className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
                        >
                          <option value="">不替换</option>
                          <option value="white_studio">白底棚拍</option>
                          <option value="warm_lifestyle">暖色生活方式</option>
                          <option value="cool_minimal">冷色极简</option>
                        </select>
                      </label>
                    </div>
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-zinc-400">
                {isAuditTestMode
                  ? '文本 AI 配置自有 Key 后不计平台额度。'
                  : '文本 AI 配置自有 Key 后不计平台额度；主图处理使用平台额度。'}
              </p>
            </fieldset>

            <button
              type="button"
              onClick={() => void runPreflight()}
              disabled={
                preflight.isPending ||
                saveDraft.isPending ||
                draftConflict ||
                resolvingDraftConflict ||
                draftQuery.isLoading ||
                draftQuery.isError ||
                attemptRecoveryBlocked ||
                publishOutcomeUnresolved ||
                !!foreignDraft ||
                selected.length === 0 ||
                !pricingInputValid ||
                !currentPricingPreview
              }
              className="w-full rounded-xl border border-brand-200 bg-brand-50 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-50"
            >
              {saveDraft.isPending
                ? '正在保存草稿…'
                : preflight.isPending
                  ? '检查中…'
                  : '检查发布条件'}
            </button>
            {!currentPricingPreview ? (
              <p className="mt-2 text-xs text-amber-600">
                请先完成售价与利润试算；任何定价策略变化都会要求重新确认。
              </p>
            ) : null}
            {preflight.isError ? (
              <p className="mt-2 text-xs text-red-600" role="alert">
                {(preflight.error as ApiError).message}
              </p>
            ) : null}
            {currentPreflight ? (
              <PreflightResult
                checks={currentPreflight.checks}
                ready={readyToPublish}
                pricingConfirmationMatches={pricingConfirmationMatches}
                shops={sellerShops}
                onActionHref={(href) => void navigateAfterDraftSave(href)}
              />
            ) : null}

            {readyToPublish ? (
              <button
                type="button"
                onClick={() => publish.mutate()}
                disabled={
                  publish.isPending ||
                  publishOutcomeUnresolved ||
                  saveDraft.isPending ||
                  resolvingDraftConflict
                }
                className="mt-3 w-full rounded-xl bg-brand-500 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {publish.isPending
                  ? '铺货中…'
                  : `确认发布到 ${publishRequest.targetShopIds.length} 个店铺`}
              </button>
            ) : null}
          </>
        )}

      {publish.isError &&
        (() => {
          const err = publish.error as ApiError;
          const upgrade = err.code === 'QUOTA_EXCEEDED' || err.code === 'FEATURE_LOCKED';
          return (
            <div
              className={`mt-3 rounded-lg p-3 text-sm ${
                upgrade ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'text-red-600'
              }`}
            >
              {err.message}
              {upgrade && (
                <a
                  href="/settings#capacity-options"
                  onClick={(event) => {
                    event.preventDefault();
                    void navigateAfterDraftSave('/settings#capacity-options');
                  }}
                  className="ml-1 font-medium underline"
                >
                  申请内测扩容 →
                </a>
              )}
            </div>
          );
        })()}

      {publish.data && (
        <div className="mt-4 space-y-2">
          {'reused' in publish.data ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
              已恢复原铺货任务，没有重复创建。当前状态：{publish.data.status} · 任务 ID：
              {publish.data.taskId}
            </div>
          ) : 'queued' in publish.data ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
              铺货任务已进入持久化队列，失败店铺会自动重试。任务 ID：{publish.data.taskId}
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-green-700">
                铺货完成（{publish.data.status}）· 售价 ¥{publish.data.salePrice}
              </p>
              <p className="text-xs text-zinc-500">优化标题：{publish.data.optimizedTitle}</p>
              {rewriteDetail && (
                <p
                  className={`text-xs ${publish.data.detailOptimized ? 'text-green-600' : 'text-amber-600'}`}
                >
                  {publish.data.detailImageHosted
                    ? '✓ 结构化详情已生成，并已转为托管长图'
                    : publish.data.detailOptimized
                      ? '✓ 结构化详情已保存；图片托管未就绪，发布时保留货源详情图'
                      : '详情生成失败，已保留货源详情图片'}
                </p>
              )}
              {publish.data.mainImageRequested && (
                <p
                  className={`text-xs ${publish.data.mainImageProcessed ? 'text-green-600' : 'text-amber-600'}`}
                >
                  {publish.data.mainImageProcessed
                    ? `✓ ${publish.data.mainImageMessage ?? '主图处理完成'}`
                    : `主图未处理，已保留货源图片：${publish.data.mainImageMessage ?? '处理服务不可用'}`}
                </p>
              )}
              <p className="text-xs text-zinc-500">
                SKU：{publish.data.skuCount} 个
                {publish.data.skuDimensions.length
                  ? ` · ${publish.data.skuDimensions.join(' / ')}`
                  : ' · 默认规格'}
              </p>
              {publish.data.results.map((r) => (
                <div
                  key={r.shopId}
                  className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{r.shopName}</span>
                  {r.platformProductId ? (
                    <span className="ml-2 text-green-600">✓ 商品ID {r.platformProductId}</span>
                  ) : (
                    <span className="ml-2 text-red-600">✗ {r.error}</span>
                  )}
                </div>
              ))}
            </>
          )}
          <a href="/published" className="inline-block text-sm text-brand-600 hover:underline">
            查看我的铺货 →
          </a>
        </div>
      )}
    </div>
  );
}

function PreflightResult({
  checks,
  ready,
  pricingConfirmationMatches,
  shops,
  onActionHref,
}: {
  checks: PublishPreflightCheck[];
  ready: boolean;
  pricingConfirmationMatches: boolean;
  shops: Array<{ id: string; shopName: string | null }>;
  onActionHref: (href: string) => void;
}) {
  const blockerCount = checks.filter((check) => check.severity === 'blocker').length;
  const shopNames = new Map(shops.map((shop) => [shop.id, shop.shopName]));

  return (
    <section
      aria-label="发布条件检查结果"
      aria-live="polite"
      className={`mt-3 rounded-xl border p-3 ${
        ready ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <div className={`text-sm font-medium ${ready ? 'text-green-800' : 'text-amber-900'}`}>
        {ready
          ? '发布条件已通过'
          : blockerCount > 0
            ? `发现 ${blockerCount} 项发布阻断`
            : '发布条件暂未通过'}
      </div>
      {checks.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {checks.map((check, index) => {
            const shopName = check.shopId
              ? (shopNames.get(check.shopId) ?? `店铺 ${check.shopId}`)
              : null;
            return (
              <li
                key={`${check.id}:${check.shopId ?? check.scope ?? 'global'}:${index}`}
                className="rounded-lg border border-black/5 bg-white/70 px-2.5 py-2 text-xs text-zinc-700"
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      check.severity === 'blocker'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {check.severity === 'blocker' ? '阻断' : '提醒'}
                  </span>
                  <span className="min-w-0 flex-1 leading-5">
                    {shopName ? <span className="mr-1 font-medium">{shopName}</span> : null}
                    {check.message}
                    {check.actionHref ? (
                      <a
                        href={check.actionHref}
                        onClick={(event) => {
                          event.preventDefault();
                          onActionHref(check.actionHref!);
                        }}
                        className="ml-1 font-medium text-brand-700 underline"
                      >
                        去处理 →
                      </a>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={`mt-1 text-xs ${ready ? 'text-green-700' : 'text-amber-800'}`}>
          {ready ? 'SKU、类目、资质、库存与价格均已核对。' : '未获得可确认的发布结果，请重新检查。'}
        </p>
      )}
      {!pricingConfirmationMatches ? (
        <p className="mt-2 text-xs text-red-700">
          利润试算与最新货源价格不一致，请重新试算后检查。
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-zinc-500">提交时服务端仍会再次完整校验。</p>
    </section>
  );
}

interface PricingFormValues {
  pricingMode: PricingStrategy['mode'];
  markup: number;
  targetMargin: number;
  competitorLow: string;
  competitorHigh: string;
  estimatedShipping: number;
  platformFeeRate: number;
}

function buildPricingStrategy(values: PricingFormValues): PricingStrategy {
  if (values.pricingMode === 'fixed_markup') {
    return { mode: 'fixed_markup', markupRatio: values.markup / 100 };
  }

  const common = {
    estimatedShipping: values.estimatedShipping,
    platformFeeRate: values.platformFeeRate / 100,
  };
  if (values.pricingMode === 'profit_target') {
    return { mode: 'profit_target', targetMargin: values.targetMargin / 100, ...common };
  }
  return {
    mode: 'competitor_anchor',
    competitorPriceRange: [Number(values.competitorLow), Number(values.competitorHigh)],
    ...common,
  };
}

function pricingFormFromDraft(strategy: PricingStrategy | null): PricingFormValues {
  const competitorRange = strategy?.competitorPriceRange;
  return {
    pricingMode: strategy?.mode ?? 'fixed_markup',
    markup: (strategy?.markupRatio ?? 0.5) * 100,
    targetMargin: (strategy?.targetMargin ?? 0.3) * 100,
    competitorLow: competitorRange ? String(competitorRange[0]) : '',
    competitorHigh: competitorRange ? String(competitorRange[1]) : '',
    estimatedShipping: strategy?.estimatedShipping ?? 4,
    platformFeeRate: (strategy?.platformFeeRate ?? 0.05) * 100,
  };
}

function publishDraftFingerprint(
  draft: Pick<
    SavePublishDraftRequest | PublishDraftView,
    'sourceProductId' | 'targetShopIds' | 'pricingStrategy' | 'aiOptions'
  >,
): string {
  return JSON.stringify(
    normalizeDraftValue({
      sourceProductId: draft.sourceProductId,
      targetShopIds: [...draft.targetShopIds].sort(),
      pricingStrategy: draft.pricingStrategy ?? null,
      aiOptions: draft.aiOptions ?? null,
    }),
  );
}

function normalizeDraftValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDraftValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeDraftValue(item)]),
  );
}

function formatDraftTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '已同步'
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function sourceUnavailableMessage(availability: Props['availability']): string | null {
  if (availability === 'available') return null;
  if (availability === 'out_of_stock') return '1688 货源已缺货';
  if (availability === 'offline') return '1688 货源已下架';
  return '1688 货源库存不可验证';
}

function NumberField({
  label,
  value,
  prefix,
  suffix,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs text-zinc-500">
      <span className="mb-1 block">{label}</span>
      <span className="flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-1.5">
        {prefix ? <span>{prefix}</span> : null}
        <input
          type="number"
          min={min}
          max={max}
          step="0.01"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-800 outline-none"
        />
        {suffix ? <span>{suffix}</span> : null}
      </span>
    </label>
  );
}

function PricingQuoteCard({ quote }: { quote: Awaited<ReturnType<typeof api.pricingPreview>> }) {
  return (
    <div className="rounded-lg bg-zinc-950 p-3 text-white">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-zinc-400">建议售价</div>
          <div className="text-lg font-semibold">¥{quote.suggestedPrice}</div>
        </div>
        <div>
          <div className="text-zinc-400">保本价</div>
          <div className="text-lg font-semibold">¥{quote.breakEvenPrice}</div>
        </div>
        <div>
          <div className="text-zinc-400">预计单件利润</div>
          <div className={quote.estimatedProfit >= 0 ? 'text-green-300' : 'text-red-300'}>
            ¥{quote.estimatedProfit}
          </div>
        </div>
        <div>
          <div className="text-zinc-400">预计毛利率</div>
          <div>{(quote.estimatedMargin * 100).toFixed(1)}%</div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">
        采购 ¥{quote.costPrice} + 运费 ¥{quote.estimatedShipping} · 平台费率{' '}
        {(quote.platformFeeRate * 100).toFixed(1)}%
      </p>
      {quote.warning ? <p className="mt-2 text-xs text-amber-300">⚠ {quote.warning}</p> : null}
    </div>
  );
}
