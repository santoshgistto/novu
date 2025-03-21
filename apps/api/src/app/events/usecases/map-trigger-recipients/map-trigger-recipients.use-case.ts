import { Injectable } from '@nestjs/common';
import {
  ISubscribersDefine,
  ITopic,
  TriggerRecipientSubscriber,
  TriggerRecipientTopics,
  TriggerRecipients,
} from '@novu/node';
import {
  EnvironmentId,
  LogCodeEnum,
  LogStatusEnum,
  OrganizationId,
  TopicKey,
  TopicSubscribersDto,
  TriggerRecipientsTypeEnum,
  UserId,
} from '@novu/shared';

import { MapTriggerRecipientsCommand } from './map-trigger-recipients.command';

import { CreateLog, CreateLogCommand } from '../../../logs/usecases/create-log';
import { GetTopicSubscribersCommand, GetTopicSubscribersUseCase } from '../../../topics/use-cases';

interface ILogTopicSubscribersPayload {
  environmentId: EnvironmentId;
  organizationId: OrganizationId;
  topicKey: TopicKey;
  transactionId: string;
  userId: UserId;
}

const isNotTopic = (recipient: TriggerRecipientSubscriber): recipient is TriggerRecipientSubscriber =>
  typeof recipient === 'string' || recipient?.type !== TriggerRecipientsTypeEnum.TOPIC;

const isTopic = (recipient: ITopic): recipient is ITopic => recipient?.type === TriggerRecipientsTypeEnum.TOPIC;

@Injectable()
export class MapTriggerRecipients {
  constructor(private createLog: CreateLog, private getTopicSubscribers: GetTopicSubscribersUseCase) {}

  async execute(command: MapTriggerRecipientsCommand): Promise<ISubscribersDefine[]> {
    const { environmentId, organizationId, recipients, transactionId, userId } = command;

    const mappedRecipients = Array.isArray(recipients) ? recipients : [recipients];

    const simpleSubscribers: ISubscribersDefine[] = this.findSubscribers(mappedRecipients);

    const topicSubscribers: ISubscribersDefine[] = await this.getSubscribersFromAllTopics(
      transactionId,
      environmentId,
      organizationId,
      userId,
      mappedRecipients
    );

    return this.deduplicateSubscribers([...simpleSubscribers, ...topicSubscribers]);
  }

  /**
   * Time complexity: O(n)
   */
  private deduplicateSubscribers(subscribers: ISubscribersDefine[]): ISubscribersDefine[] {
    const uniqueSubscribers = new Set();

    return subscribers.filter((el) => {
      const isDuplicate = uniqueSubscribers.has(el.subscriberId);
      uniqueSubscribers.add(el.subscriberId);

      return !isDuplicate;
    });
  }

  private async getSubscribersFromAllTopics(
    transactionId: string,
    environmentId: EnvironmentId,
    organizationId: OrganizationId,
    userId: UserId,
    recipients: TriggerRecipients
  ): Promise<ISubscribersDefine[]> {
    /*
     * TODO: We should manage the env variables from the config and not process.env
     * https://github.com/motdotla/dotenv/issues/51
     */
    if (process.env.FF_IS_TOPIC_NOTIFICATION_ENABLED === 'true') {
      const topics = this.findTopics(recipients);

      const subscribers: ISubscribersDefine[] = [];

      for (const topic of topics) {
        try {
          const getTopicSubscribersCommand = GetTopicSubscribersCommand.create({
            environmentId,
            topicKey: topic.topicKey,
            organizationId,
          });
          const topicSubscribers = await this.getTopicSubscribers.execute(getTopicSubscribersCommand);

          topicSubscribers.forEach((subscriber: TopicSubscribersDto) =>
            subscribers.push({ subscriberId: subscriber.externalSubscriberId })
          );
        } catch (error) {
          this.logTopicSubscribersError({
            environmentId,
            organizationId,
            topicKey: topic.topicKey,
            transactionId,
            userId,
          });
        }
      }

      return subscribers;
    }

    return [];
  }

  public mapSubscriber(subscriber: TriggerRecipientSubscriber): ISubscribersDefine {
    if (typeof subscriber === 'string') {
      return { subscriberId: subscriber };
    }

    return subscriber;
  }

  private findSubscribers(recipients: TriggerRecipients): ISubscribersDefine[] {
    return recipients.filter(isNotTopic).map(this.mapSubscriber);
  }

  private findTopics(recipients: TriggerRecipients): TriggerRecipientTopics {
    return recipients.filter(isTopic);
  }

  private logTopicSubscribersError({
    environmentId,
    organizationId,
    topicKey,
    transactionId,
    userId,
  }: ILogTopicSubscribersPayload) {
    this.createLog
      .execute(
        CreateLogCommand.create({
          transactionId,
          status: LogStatusEnum.ERROR,
          environmentId,
          organizationId,
          text: 'Failed retrieving topic subscribers',
          userId,
          code: LogCodeEnum.TOPIC_SUBSCRIBERS_ERROR,
          raw: {
            topicKey,
          },
        })
      )
      // eslint-disable-next-line no-console
      .catch((e) => console.error(e));
  }
}
